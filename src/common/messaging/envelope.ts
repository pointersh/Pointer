
export interface Envelope<T = unknown> {
  type: string
  data?: T
  id?: string
  error?: string
}

export const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Envelope).type === "string"
