import { commands, ExtensionContext, window } from "vscode"

import { POINTER_COMMAND_NAME } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import { describeServer } from "../../common/provider-discovery"
import { PointerProvider } from "../../common/types"

import { applyDiscoveredServer, discoverLocalServers } from "./discovery"
import { ProviderStore } from "./store"

const SETUP_NOTICE_KEY = "pointer.provider-setup-notice-shown"

const JOB_NAMES: Record<string, string> = {
  chat: "chat",
  fim: "autocomplete",
  embedding: "embeddings"
}

const listJobs = (providers: PointerProvider[]) =>
  providers.map((p) => JOB_NAMES[p.type] || p.type).join(", ")

export const openProviderTab = async () => {
  await commands.executeCommand(POINTER_COMMAND_NAME.focusSidebar)
  await commands.executeCommand(POINTER_COMMAND_NAME.manageProviders)
}

let setupDone: Promise<void> = Promise.resolve()

export const whenProviderSetupDone = () => setupDone

export const setUpProvidersOnFirstRun = (
  context: ExtensionContext,
  store: ProviderStore
): Promise<void> => {
  setupDone = run(context, store).catch((error) => {
    logger.error(
      `Provider setup failed: ${
        messageOf(error)
      }`
    )
  })
  return setupDone
}

async function run(context: ExtensionContext, store: ProviderStore) {
  await store.migrateLegacy()
  if (await store.hasProviders()) {
    await store.repairActive()
    return
  }

  const servers = await discoverLocalServers()
  if (servers.length > 0) {
    const server = servers[0]
    const providers = await applyDiscoveredServer(store, server)
    logger.info(`Set up ${listJobs(providers)} from ${describeServer(server)}`)
    void window
      .showInformationMessage(
        `Pointer found ${describeServer(server)} and set it up for ${listJobs(
          providers
        )}.`,
        "Change providers"
      )
      .then((choice) => choice && openProviderTab())
    return
  }

  if (context.globalState.get<boolean>(SETUP_NOTICE_KEY)) return
  await context.globalState.update(SETUP_NOTICE_KEY, true)
  void window
    .showInformationMessage(
      "Pointer needs a model provider. No local server (Ollama, LM Studio, llama.cpp…) answered on the usual ports.",
      "Choose a provider"
    )
    .then((choice) => choice && openProviderTab())
}
