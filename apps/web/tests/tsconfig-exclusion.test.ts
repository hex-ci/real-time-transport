import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The type-check scope of this package, held against the config that defines it.
 *
 * `tsconfig.app.json` excludes this package's test files — every `__tests__`
 * directory under `src/` — so `vue-tsc --build` never type-checks them. That
 * exclusion is deliberate and stays: a test is transformed and run by Vitest,
 * against the types the runner gives it, not by the app build. What can be lost
 * without a word is the REASON — an exclusion carrying none reads as an oversight,
 * and the next reader re-includes the tests, reddens a build nobody changed, and
 * takes the exclusion out again. So the config must say so in place, and say it as
 * a standing constraint rather than as history.
 *
 * These are structural checks — a presence and a wording check on a config line,
 * the only thing that can be said about a setting no runtime reads. They are
 * deliberately loose about the phrasing and tight about the facts: the tests are
 * still excluded, the file states that this is deliberate, it says what that costs
 * (those files go unchecked), and it does not describe itself as a temporary state
 * or a to-do.
 *
 * This file lives outside `src/` for the same reason `installability.test.ts`
 * does: it verifies a package-config surface, not a module.
 */

const tsconfig = readFileSync(
  fileURLToPath(new URL('../tsconfig.app.json', import.meta.url)),
  'utf8',
)

/** Every `//` comment line in the config, joined — the prose the file carries. */
function statedReason(source: string): string {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('//'))
    .join(' ')
}

describe('test files stay out of the app type check, and the config says so', () => {
  it('still excludes this package\'s test files', () => {
    // The decision under test is about a deliberate exclusion, so the exclusion
    // itself is pinned: a file with the right comment and no exclude key would
    // pass a prose-only check while type-checking something nobody wants checked.
    expect(tsconfig).toContain('src/**/__tests__/*')
  })

  it('states the exclusion is deliberate, where the exclusion is', () => {
    const stated = statedReason(tsconfig)
    expect(stated.length, 'the exclusion of test files is stated nowhere in the config')
      .toBeGreaterThan(0)
    expect(stated, 'the config does not say the test exclusion is deliberate')
      .toMatch(/deliberate|intentional|standing/i)
    expect(stated, 'the config does not name what it applies to')
      .toMatch(/test/i)
  })

  it('does not describe the exclusion as history or as an unfinished job', () => {
    const stated = statedReason(tsconfig)
    // A 待办 or a 「暂时」 invites exactly the re-inclusion this comment exists to
    // prevent, so the file may not read as either.
    expect(stated, 'the config words the exclusion as temporary')
      .not.toMatch(/temporar|for now|for the moment/i)
    expect(stated, 'the config words the exclusion as an unfinished job')
      .not.toMatch(/TODO|FIXME/i)
  })

  it('says the excluded tests are not type-checked, so nobody assumes they are', () => {
    // The second fact, in the same place: excluded means the type checker never
    // reads them. The wording is free; the claim is not — a comment that says the
    // opposite, or leaves the reader to assume the opposite, is the
    // misunderstanding this pin exists to catch.
    expect(statedReason(tsconfig), 'the config does not say the excluded tests go unchecked')
      .toMatch(/(never|not|isn't|aren't)\s*(type-?check|checked)/i)
  })
})
