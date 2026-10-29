export type Semver = { core: readonly string[]; prerelease: readonly string[] }

export function parseSemver(value: string | undefined): Semver | undefined {
  const match = value?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return undefined
  const prerelease = match[4]?.split('.') || []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return { core: match.slice(1, 4), prerelease }
}

function compareNumeric(left: string, right: string): number {
  return left.length === right.length ? (left > right ? 1 : left < right ? -1 : 0) : left.length - right.length
}

export function compareSemver(left: string | undefined, right: string | undefined): number | undefined {
  const parsedLeft = parseSemver(left)
  const parsedRight = parseSemver(right)
  if (!parsedLeft || !parsedRight) return undefined
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const compared = compareNumeric(parsedLeft.core[index], parsedRight.core[index])
    if (compared) return compared
  }
  if (!parsedLeft.prerelease.length || !parsedRight.prerelease.length) {
    return Number(!parsedLeft.prerelease.length) - Number(!parsedRight.prerelease.length)
  }
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index]
    const rightPart = parsedRight.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}
