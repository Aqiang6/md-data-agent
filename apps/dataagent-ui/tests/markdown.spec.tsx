/** Request Markdown does not fetch images embedded in prompt examples. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown.tsx'

describe('request Markdown', () => {
  it('retains image references as text without an image element', () => {
    const rendered = renderToStaticMarkup(<Markdown text={'# Prompt\n\n![Example](https://example.com/image.png)'} renderImages={false} />)
    expect(rendered).toContain('<h1>Prompt</h1>')
    expect(rendered).toContain('<code>![Example](https://example.com/image.png)</code>')
    expect(rendered).not.toContain('<img')
  })

  it('renders ordinary report images without enabling raw HTML', () => {
    const rendered = renderToStaticMarkup(<Markdown text={'![Chart](/api/data/artifact?id=chart)\n\n<script>alert(1)</script>'} />)
    expect(rendered).toContain('<img')
    expect(rendered).not.toContain('<script>')
  })
})
