import { PluginKey } from "@tiptap/pm/state"
import { Extension } from "@tiptap/react"

import { CodeLanguage, supportedLanguages } from "../common/languages"
import { LanguageType } from "../common/types"

export { getLineBreakCount, kebabToSentence } from "../common/text"

const MentionPluginKey = new PluginKey("mention")

export const getLanguageMatch = (
  language: LanguageType | undefined,
  className: string | undefined
) => {
  const match = /language-(\w+)/.exec(className || "")

  if (match && match.length) {
    const matchedLanguage = supportedLanguages[match[1] as CodeLanguage]

    return matchedLanguage && matchedLanguage.derivedFrom
      ? matchedLanguage.derivedFrom
      : match[1]
  }

  if (language && language.languageId) {
    const languageId = language.languageId.toString()
    const languageEntry = supportedLanguages[languageId as CodeLanguage]

    return languageEntry && languageEntry.derivedFrom
      ? languageEntry.derivedFrom
      : languageId
  }

  return "auto"
}

export const CustomKeyMap = Extension.create({
  name: "chatKeyMap",

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) {
          return false
        }
        if (editor.isEmpty && this.options.approve?.("run")) return true
        this.options.handleSubmitForm()
        this.options.clearEditor()
        return true
      },
      "Mod-Enter": ({ editor }) => {
        editor.commands.insertContent("\n")
        return true
      },
      "Shift-Enter": ({ editor }) => {
        if (editor.isEmpty && this.options.approve?.("always")) return true
        editor.commands.insertContent("\n")
        return true
      },
      Escape: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.escape?.() ?? false
      },
      "Ctrl-c": ({ editor }) => {
        if (!editor.state.selection.empty) return false
        return this.options.interrupt?.() ?? false
      },
      "Ctrl-l": () => this.options.newConversation?.() ?? false,
      "?": ({ editor }) => {
        if (!editor.isEmpty) return false
        return this.options.toggleShortcuts?.() ?? false
      },
      "Shift-Tab": ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.toggleAgentMode?.() ?? false
      },
      PageUp: () => this.options.scrollTranscript?.(-1) ?? false,
      PageDown: () => this.options.scrollTranscript?.(1) ?? false,
      ArrowUp: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.recallPrompt?.(-1, editor.isEmpty) ?? false
      },
      ArrowDown: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.recallPrompt?.(1, editor.isEmpty) ?? false
      },
    }
  },
})

export const getThinkingMessage = (content: string): { thinking: string | null; message: string } => {
  const blocks = [...content.matchAll(/<(?:think|thinking)>([\s\S]*?)(?:<\/(?:think|thinking)>|$)/g)];
  if (!blocks.length) return { thinking: null, message: content };

  const thinking = blocks.map((block) => block[1].trim()).filter(Boolean).join("\n\n");
  const message = content.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/g, "").trim();
  return { thinking, message };
};
