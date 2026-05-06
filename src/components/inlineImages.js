// Shared helper: replace local <img src> references with base64 data URIs
// so they render in every email client without needing a public host.

function basename(path) {
  if (!path) return ''
  const cleaned = String(path).split(/[?#]/)[0]
  const parts = cleaned.split(/[\\/]/)
  return decodeURIComponent(parts[parts.length - 1] || '').toLowerCase()
}

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ filename: file.name, dataUri: r.result.toString(), size: file.size })
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

// Pick image files, read as base64 data URIs, and rewrite matching <img src=".."> tags in `body`.
// Returns { newBody, inlined: [{filename, size}], unmatched: [filenames in body that weren't supplied] }
export async function inlineImagesIntoBody(body, files) {
  if (!body) body = ''
  const fileList = await Promise.all(files.map(fileToDataUri))
  const byName = new Map()
  for (const f of fileList) byName.set(basename(f.filename), f.dataUri)

  let newBody = body
  const inlined = []
  // Replace src/srcset for any <img> whose src filename matches an uploaded file
  newBody = newBody.replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (tag, src) => {
    // Skip if already absolute http/https or a data: URI
    if (/^(https?:|data:)/i.test(src)) return tag
    const name = basename(src)
    const dataUri = byName.get(name)
    if (!dataUri) return tag
    inlined.push(name)
    return tag.replace(src, dataUri)
  })

  // Find all img srcs in the body that we didn't manage to replace (still local paths)
  const unmatched = []
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(newBody)) !== null) {
    if (!/^(https?:|data:)/i.test(m[1])) unmatched.push(basename(m[1]))
  }

  return { newBody, inlined, unmatched }
}
