/** Extracts the image name (last path segment, without tag) from a container image reference. */
export function inferNameFromImage(imageRef: string): string {
  const colonIdx = imageRef.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !imageRef.substring(colonIdx).includes('/')
  const withoutTag = hasTag ? imageRef.substring(0, colonIdx) : imageRef
  const segments = withoutTag.split('/')
  return segments[segments.length - 1]
}

/** Splits an image reference into its image path and tag. */
export function parseImageRef(ref: string): { image: string; tag: string } {
  const colonIdx = ref.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !ref.substring(colonIdx).includes('/')
  return {
    image: hasTag ? ref.substring(0, colonIdx) : ref,
    tag: hasTag ? ref.substring(colonIdx + 1) : 'latest'
  }
}

/** Returns true if the argument looks like a container image reference (contains `/` or `:`). */
export function isImageReference(arg: string): boolean {
  return arg.includes('/') || arg.includes(':')
}
