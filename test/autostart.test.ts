import { describe, expect, it } from 'vitest'
import { LABEL, plistFor } from '../src/autostart/launchd.js'
import { resolveAutostart } from '../src/autostart/resolve.js'
import { UNIT, unitFor } from '../src/autostart/systemd.js'

describe('resolveAutostart', () => {
  it('maps each supported platform to its native mechanism', () => {
    expect(resolveAutostart('darwin')?.name).toContain('launchd')
    expect(resolveAutostart('linux')?.name).toContain('systemd')
    expect(resolveAutostart('win32')?.name).toContain('Windows')
  })

  it('returns null on an unsupported platform instead of throwing', () => {
    // `start` must still work there; only the login-time piece is unavailable.
    expect(resolveAutostart('aix')).toBeNull()
  })
})

describe('launchd plist', () => {
  it('runs the daemon at load', () => {
    const plist = plistFor(15)
    expect(plist).toContain(`<string>${LABEL}</string>`)
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).toContain('<string>daemon</string>')
    expect(plist).toContain('<string>15</string>')
  })

  it('(bug) only restarts after a failed exit, so `stop` is not undone', () => {
    // An unconditional KeepAlive respawned the service seconds after a deliberate stop, and spun
    // relaunching a second copy that immediately exited against the lockfile.
    const plist = plistFor(15)
    expect(plist).toContain('<key>SuccessfulExit</key>')
    expect(plist).not.toContain('<key>KeepAlive</key>\n  <true/>')
  })

  it('is well-formed XML with balanced plist tags', () => {
    const plist = plistFor(15)
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true)
    expect(plist).toContain('<plist version="1.0">')
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true)
    expect((plist.match(/<dict>/g) ?? []).length).toBe((plist.match(/<\/dict>/g) ?? []).length)
    expect((plist.match(/<array>/g) ?? []).length).toBe((plist.match(/<\/array>/g) ?? []).length)
  })

  it('(bug) escapes XML metacharacters in paths', () => {
    // A directory named `A & B` would otherwise produce a plist launchd refuses to parse, leaving
    // autostart silently broken.
    const previous = process.env.TIKR_HOME
    process.env.TIKR_HOME = '/tmp/a & b/<x>'
    try {
      const plist = plistFor(15)
      expect(plist).toContain('/tmp/a &amp; b/&lt;x&gt;')
      expect(plist).not.toContain('/tmp/a & b/<x>')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'TIKR_HOME')
      else process.env.TIKR_HOME = previous
    }
  })

  it('carries the state directory through, so a reboot keeps a custom location', () => {
    expect(plistFor(15)).toContain('<key>TIKR_HOME</key>')
  })
})

describe('systemd unit', () => {
  it('starts with the user session and restarts on failure', () => {
    const unit = unitFor(30)
    expect(unit).toContain('[Install]\nWantedBy=default.target')
    // on-failure, not always: `always` would restart the service after a deliberate stop.
    expect(unit).toContain('Restart=on-failure')
    expect(unit).not.toContain('Restart=always')
    expect(unit).toContain('daemon --interval 30')
    expect(UNIT).toBe('tikr.service')
  })

  it('sets the state directory explicitly, since user units inherit no shell environment', () => {
    expect(unitFor(30)).toContain('Environment=TIKR_HOME=')
  })
})
