/** Live table metadata for the human database browser. */
import { z } from 'zod'

/** Actual field metadata, distinct from user-authored business meanings. */
export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  key: string
  comment: string
  references: string[]
}
/** A table or view discovered from the selected database. */
export interface SchemaTable {
  name: string
  columns: SchemaColumn[]
}
/** Actual fields returned to the human table browser, without Markdown generation. */
export interface DatabaseMetadata {
  database: string
  tables: SchemaTable[]
}

/** Decode metadata at the worker JSON boundary.
 * @param raw - SQLite PRAGMA or MySQL information_schema result.
 * @param sqlite - metadata dialect.
 * @returns normalized table and field records.
 */
export function decodeSchema(raw: unknown, sqlite: boolean): SchemaTable[] {
  if (sqlite) {
    const decoded = z
      .object({
        tables: z.array(
          z.object({
            name: z.string(),
            columns: z.array(
              z.object({ name: z.string(), type: z.string(), notnull: z.number(), pk: z.number() }),
            ),
            relations: z.array(z.object({ from: z.string(), table: z.string(), to: z.string().nullable() })),
          }),
        ),
      })
      .parse(raw)
    return decoded.tables.map(table => ({
      name: table.name,
      columns: table.columns.map(column => ({
        name: column.name,
        type: column.type,
        nullable: column.notnull === 0 && column.pk === 0,
        key: column.pk ? 'PRIMARY' : '',
        comment: '',
        references: table.relations
          .filter(relation => relation.from === column.name)
          .map(relation => `${relation.table}.${relation.to ?? '(primary key)'}`),
      })),
    }))
  }
  const decoded = z
    .object({
      rows: z.array(
        z.object({
          TABLE_NAME: z.string(),
          COLUMN_NAME: z.string(),
          COLUMN_TYPE: z.string(),
          IS_NULLABLE: z.string(),
          COLUMN_KEY: z.string(),
          COLUMN_COMMENT: z.string(),
          REFERENCED_TABLE_NAME: z.string().nullable(),
          REFERENCED_COLUMN_NAME: z.string().nullable(),
        }),
      ),
    })
    .parse(raw)
  const tables = new Map<string, SchemaTable>()
  for (const row of decoded.rows) {
    let table = tables.get(row.TABLE_NAME)
    if (!table) {
      table = { name: row.TABLE_NAME, columns: [] }
      tables.set(table.name, table)
    }
    let column = table.columns.find(item => item.name === row.COLUMN_NAME)
    if (!column) {
      column = {
        name: row.COLUMN_NAME,
        type: row.COLUMN_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
        key: row.COLUMN_KEY,
        comment: row.COLUMN_COMMENT,
        references: [],
      }
      table.columns.push(column)
    }
    if (row.REFERENCED_TABLE_NAME)
      column.references.push(`${row.REFERENCED_TABLE_NAME}.${row.REFERENCED_COLUMN_NAME}`)
  }
  return [...tables.values()]
}
