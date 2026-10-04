/** Nominal identifiers for session-owned Data Agent evidence and observations. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Immutable document source identifier. */
export type DocumentId = Branded<'DataDocumentId'>
/** Complete structured calculation result identifier. */
export type ResultId = Branded<'DataResultId'>
/** Downloadable artifact identifier. */
export type ArtifactId = Branded<'DataArtifactId'>
/** Harness request attempt identifier. */
export type RequestId = Branded<'DataRequestId'>
/** Report revision family identifier. */
export type ReportId = Branded<'DataReportId'>
/** Stored database connection identifier. */
export type ConnectionId = Branded<'DataConnectionId'>

/** Brand an admitted document identifier.
 * @param value - source digest.
 * @returns nominal identifier.
 */
export const DocumentId = (value: string): DocumentId => brandString<DocumentId>(value)
/** Brand an admitted result identifier.
 * @param value - generated or validated UUID.
 * @returns nominal identifier.
 */
export const ResultId = (value: string): ResultId => brandString<ResultId>(value)
/** Brand an admitted artifact identifier.
 * @param value - generated or validated UUID.
 * @returns nominal identifier.
 */
export const ArtifactId = (value: string): ArtifactId => brandString<ArtifactId>(value)
/** Brand an admitted request identifier.
 * @param value - generated or validated UUID.
 * @returns nominal identifier.
 */
export const RequestId = (value: string): RequestId => brandString<RequestId>(value)
/** Brand an admitted report identifier.
 * @param value - generated or validated UUID.
 * @returns nominal identifier.
 */
export const ReportId = (value: string): ReportId => brandString<ReportId>(value)
/** Brand an admitted connection identifier.
 * @param value - generated or validated UUID.
 * @returns nominal identifier.
 */
export const ConnectionId = (value: string): ConnectionId => brandString<ConnectionId>(value)
