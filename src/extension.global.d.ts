declare module "@tiptap/extension-placeholder"

declare module "*.css"

declare module "*.css" {
  const content: Record<string, string>
  export default content
}

declare module "*.svg" {
  const content: string
  export default content
}

interface VsCodeApi<State = unknown> {
  getState: () => State
  setState: (data: State) => void
  postMessage: (message: unknown) => void
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>

interface Window {
  acquireVsCodeApi: typeof acquireVsCodeApi
}
