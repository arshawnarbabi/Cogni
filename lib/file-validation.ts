const TEXT_EXTS = new Set(['txt', 'md'])

async function readHeader(input: Blob | Uint8Array, length = 16): Promise<Uint8Array> {
  if (input instanceof Blob) {
    return new Uint8Array(await input.slice(0, length).arrayBuffer())
  }
  return input.slice(0, length)
}

export async function hasExpectedFileSignature(input: Blob | Uint8Array, ext: string): Promise<boolean> {
  const normalized = ext.toLowerCase().replace('.', '')
  if (TEXT_EXTS.has(normalized)) return true

  const bytes = await readHeader(input)
  const startsWith = (signature: number[]) => signature.every((b, i) => bytes[i] === b)

  if (normalized === 'pdf') return startsWith([0x25, 0x50, 0x44, 0x46])
  if (normalized === 'png') return startsWith([0x89, 0x50, 0x4e, 0x47])
  if (normalized === 'jpg' || normalized === 'jpeg') return startsWith([0xff, 0xd8, 0xff])
  if (normalized === 'webp') {
    return startsWith([0x52, 0x49, 0x46, 0x46]) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
  }
  if (normalized === 'docx') return startsWith([0x50, 0x4b, 0x03, 0x04])

  return false
}
