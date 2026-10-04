/** Bounded database execution in a terminable worker; no model-authored code. */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs'
import sqlite from '@appthreat/sqlite3'

const request = workerData
const originalSql = request.sql
let activeDatabase
let activeDuckDB
let activeMysql
let cancelled = false
parentPort.on('message', (message) => {
  if (message?.cancel !== true) return
  cancelled = true
  activeDatabase?.interrupt()
  activeDuckDB?.interrupt()
  activeMysql?.destroy()
})
const quote = (name) => '"' + name.replaceAll('"', '""') + '"'
const jsonValue = (value) =>
  typeof value === 'bigint'
    ? Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString()
    : value instanceof Uint8Array
      ? Buffer.from(value).toString('hex')
      : value instanceof Date
        ? value.toISOString()
        : value

function screen(sql, dialect) {
  const tokens = sql.match(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]]|\]\])*\]|[A-Za-z_][A-Za-z_0-9]*|;|[^\s]/g) ?? []
  const words = tokens.filter(token => !token.startsWith('--') && !token.startsWith('#') && !token.startsWith('/*'))
  if (tokens.some(token => token.startsWith('/*!'))) throw new Error('Executable SQL comments are not read-only queries.')
  if (words.at(-1) === ';') words.pop()
  if (words.includes(';')) throw new Error('Run one read-only statement at a time.')
  const heads = dialect === 'MySQL' ? ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'] : ['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA']
  if (!heads.includes(words[0]?.toUpperCase())) throw new Error('Only read-only SQL is allowed.')
  if (words.some((word, index) => word.toUpperCase() === 'INTO' && ['OUTFILE', 'DUMPFILE'].includes(words[index + 1]?.toUpperCase())))
    throw new Error('SQL file writes are not allowed.')
  return words[0]?.toUpperCase()
}

let outputFile
function collector(columns) {
  const rows = []
  let rowCount = 0
  let bytes = 0
  if (request.outputPath) {
    outputFile = openSync(request.outputPath, 'wx')
    writeSync(outputFile, JSON.stringify({ database: request.database ?? request.path, sql: originalSql, params: request.params ?? [], columns }).slice(0, -1) + ',"rows":[\n')
  }
  return {
    add(row) {
      if (request.maxRows > 0 && rowCount >= request.maxRows) throw new Error('Complete-result row limit exceeded.')
      const json = JSON.stringify(row)
      bytes += Buffer.byteLength(json)
      if (request.maxBytes > 0 && bytes > request.maxBytes) throw new Error('Complete-result byte limit exceeded.')
      if (outputFile !== undefined) writeSync(outputFile, (rowCount ? ',\n' : '') + json)
      if (!request.outputPath || rows.length < request.previewRows) rows.push(row)
      rowCount++
    },
    finish() {
      if (outputFile !== undefined) { writeSync(outputFile, '\n]}\n'); closeSync(outputFile); outputFile = undefined }
      return { columns, rows, rowCount, truncated: rowCount > rows.length }
    },
  }
}

function uniqueColumns(names) {
  const seen = new Set()
  return names.map(name => {
    let candidate = name
    let suffix = 2
    while (seen.has(candidate)) candidate = name + '_' + suffix++
    seen.add(candidate)
    return candidate
  })
}

async function collectAsync(path, sql, columns, params = []) {
  if (cancelled) throw new Error('Data operation cancelled.')
  const database = await new Promise((accept, reject) => {
    const db = new sqlite.Database(path, sqlite.OPEN_READONLY, (error) =>
      error ? reject(error) : accept(db),
    )
  })
  activeDatabase = database
  let statement
  try {
    statement = await new Promise((accept, reject) => {
      const prepared = database.prepare(sql, (error) => (error ? reject(error) : accept(prepared)))
    })
    await new Promise((accept, reject) => database.exec('PRAGMA query_only = ON', error => error ? reject(error) : accept()))
    const output = collector(columns)
    let first = true
    while (true) {
      if (cancelled) throw new Error('Data operation cancelled.')
      const raw = await new Promise((accept, reject) => {
        const callback = (error, row) => (error ? reject(error) : accept(row))
        if (first)
          statement.get(
            params.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
            callback,
          )
        else statement.get(callback)
      })
      first = false
      if (raw === undefined) break
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, jsonValue(value)]))
      output.add(row)
    }
    return output.finish()
  } finally {
    if (statement)
      await new Promise((accept, reject) => statement.finalize((error) => (error ? reject(error) : accept())))
    await new Promise((accept, reject) => database.close((error) => (error ? reject(error) : accept())))
    activeDatabase = undefined
  }
}

function loadTable(db, name, result) {
  db.exec(`CREATE TABLE ${quote(name)} (${result.columns.map((column) => `${quote(column)}`).join(',')})`)
  const statement = db.prepare(
    `INSERT INTO ${quote(name)} VALUES (${result.columns.map(() => '?').join(',')})`,
  )
  for (const row of result.rows)
    statement.run(
      ...result.columns.map((column) => {
        const value = row[column]
        return value === null || value === undefined
          ? null
          : typeof value === 'boolean'
            ? Number(value)
            : value
      }),
    )
}

async function execute() {
  if (request.action === 'mysql') {
    screen(request.sql, 'MySQL')
    const mysql = await import('mysql2')
    const connection = mysql.createConnection({
      uri: request.url,
      database: request.database,
      dateStrings: true,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      rowsAsArray: true,
      ...(request.tls ? { ssl: { rejectUnauthorized: true } } : {}),
    })
    activeMysql = connection
    const promise = connection.promise()
    try {
      await promise.query('SET SESSION TRANSACTION READ ONLY')
      await promise.query('START TRANSACTION READ ONLY')
      const query = connection.query(request.sql, request.params ?? [])
      let output
      let columns = []
      query.on('fields', fields => { columns = uniqueColumns(fields.map(field => field.name)); output = collector(columns) })
      for await (const raw of query.stream()) {
        output.add(Object.fromEntries(columns.map((name, index) => [name, jsonValue(raw[index])])))
      }
      await promise.rollback()
      return output.finish()
    } finally {
      connection.destroy()
      activeMysql = undefined
    }
  }
  if (request.action === 'mysql-create') {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.databaseName))
      throw new Error('Invalid new database name.')
    const mysql = await import('mysql2')
    const connection = mysql.createConnection({
      uri: request.url,
      multipleStatements: false,
      ...(request.tls ? { ssl: { rejectUnauthorized: true } } : {}),
    })
    activeMysql = connection
    try {
      await connection.promise().query(`CREATE DATABASE \`${request.databaseName}\` CHARACTER SET utf8mb4`)
      return { created: request.databaseName }
    } finally {
      connection.destroy()
      activeMysql = undefined
    }
  }
  if (request.action === 'import') {
    let datasets
    if (request.extension === '.xlsx') {
      const { default: ExcelJS } = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(request.path)
      datasets = workbook.worksheets.map((sheet, index) => {
        const columns = sheet
          .getRow(1)
          .values.slice(1)
          .map((value, column) => String(value ?? `column_${column + 1}`))
        if (
          columns.length === 0 ||
          columns.some((column) => !column) ||
          new Set(columns).size !== columns.length
        )
          throw new Error(`Worksheet ${sheet.name} needs unique nonempty headers.`)
        if (request.maxRows > 0 && sheet.rowCount - 1 > request.maxRows) throw new Error('Import row limit exceeded.')
        const rows = []
        for (let number = 2; number <= sheet.rowCount; number++) {
          const row = sheet.getRow(number)
          rows.push(
            Object.fromEntries(
              columns.map((column, i) => {
                const cell = row.getCell(i + 1)
                if (cell.type === ExcelJS.ValueType.Formula && cell.result === undefined)
                  throw new Error('Formula cells require cached results.')
                const value = cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value
                if (value && typeof value === 'object' && !(value instanceof Date))
                  throw new Error('Unsupported rich/link/error cell; export plain values first.')
                return [column, jsonValue(value ?? null)]
              }),
            ),
          )
        }
        return { name: `sheet_${index + 1}`, label: sheet.name, columns, rows }
      })
    } else {
      const { DuckDBInstance } = await import('@duckdb/node-api')
      const instance = await DuckDBInstance.create(':memory:')
      const connection = await instance.connect()
      activeDuckDB = connection
      try {
        const reader = await connection.runAndReadAll(
          `SELECT * FROM ${request.extension === '.parquet' ? 'read_parquet' : 'read_csv_auto'}(?) LIMIT ${request.maxRows + 1}`,
          [request.path],
        )
        const rows = reader.getRowObjectsJson()
        if (request.maxRows > 0 && rows.length > request.maxRows) throw new Error('Import row limit exceeded.')
        datasets = [{ name: 'data', label: 'data', columns: reader.columnNames(), rows }]
      } finally {
        connection.closeSync()
        instance.closeSync()
        activeDuckDB = undefined
      }
    }
    if (request.maxBytes > 0 && Buffer.byteLength(JSON.stringify(datasets)) > request.maxBytes)
      throw new Error('Import byte limit exceeded.')
    const db = new DatabaseSync(request.destination)
    try {
      for (const dataset of datasets) loadTable(db, dataset.name, dataset)
    } finally {
      db.close()
    }
    return { tables: datasets.map(({ name, label, columns }) => ({ name, label, columns })) }
  }
  const path = request.action === 'analysis' ? request.scratchPath : request.path
  const db = new DatabaseSync(path, { readOnly: request.action !== 'analysis' })
  let columns
  try {
    if (request.action === 'schema') {
      const tables = db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
      return {
        tables: tables.map((table) => ({
          ...table,
          columns: db.prepare(`PRAGMA table_info(${quote(table.name)})`).all(),
          relations: db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all(),
        })),
      }
    }
    if (request.action === 'analysis') {
      loadTable(db, 'data', JSON.parse(readFileSync(request.resultPath, 'utf8')))
      if (request.rightPath) loadTable(db, 'right_data', JSON.parse(readFileSync(request.rightPath, 'utf8')))
    } else {
      screen(request.sql, 'SQLite')
    }
    db.exec('PRAGMA query_only = ON')
    let sql = request.sql.trim().replace(/;(?=(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$)/, '')
    if (['SELECT', 'WITH'].includes(screen(sql, 'SQLite'))) {
      const fields = db.prepare('SELECT * FROM (\n' + sql + '\n)').columns().map(column => column.name)
      sql = 'WITH __data_agent_result AS MATERIALIZED (\n' + sql + '\n) SELECT ' + fields.map(name => 'CASE WHEN typeof(' + quote(name) + ")='integer' AND (" + quote(name) + '>9007199254740991 OR ' + quote(name) + '<-9007199254740991) THEN CAST(' + quote(name) + ' AS TEXT) ELSE ' + quote(name) + ' END AS ' + quote(name)).join(',') + ' FROM __data_agent_result'
    }
    request.sql = sql
    columns = db.prepare(sql).columns().map(column => column.name)
  } finally {
    db.close()
  }
  return collectAsync(path, request.sql, columns, request.params)
}

try {
  parentPort.postMessage({ ok: true, value: await execute() })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
if (outputFile !== undefined) closeSync(outputFile)
parentPort.close()
