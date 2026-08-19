import { resolveAutostart } from '../autostart/resolve.js'
import { wantOtlp } from '../core/setup.js'
import { type Args, flagInt } from '../util/args.js'
import { DEFAULT_INTERVAL_SECONDS } from './daemon.js'

export function runEnable(args: Args): number {
  const backend = resolveAutostart()
  if (backend === null) {
    console.error(`Starting at login is not supported on platform "${process.platform}".`)
    return 1
  }
  const intervalSeconds = flagInt(args, 'interval', DEFAULT_INTERVAL_SECONDS)
  const otlp = wantOtlp(args)
  backend.enable(intervalSeconds, otlp)
  console.log(`Enabled start at login via ${backend.name}.`)
  console.log(`  ${backend.location()}`)
  return 0
}

export function runDisable(): number {
  const backend = resolveAutostart()
  if (backend === null) {
    console.log(`Nothing to disable on platform "${process.platform}".`)
    return 0
  }
  backend.disable()
  console.log(`Disabled start at login (${backend.name}).`)
  console.log('The service keeps running until you also run `tikr stop`.')
  return 0
}
