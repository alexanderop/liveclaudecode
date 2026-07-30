import { disposeRuntime } from '../utils/runtime'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', disposeRuntime)
})
