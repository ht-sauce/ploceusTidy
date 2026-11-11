import { describe, expect, it } from 'vitest'
import { toEditorHtml, toStoredHtml } from './richTextHtml'

const toUrl = (name: string) => `http://richasset.localhost/${name}`

describe('richTextHtml', () => {
  it('只把 src 里的 assets 引用换成协议地址，正文和链接保持原样', () => {
    const html =
      '<p>见 https://github.com/demo/assets/foo.png</p><img src="assets/foo.png"><video src=\'assets/bar.mp4\'></video>'
    expect(toEditorHtml(html, toUrl)).toBe(
      '<p>见 https://github.com/demo/assets/foo.png</p><img src="http://richasset.localhost/foo.png"><video src=\'http://richasset.localhost/bar.mp4\'></video>',
    )
  })

  it('保存时只还原 src 里的协议地址，正文里的同类文本不改', () => {
    const html =
      '<p>原文 http://richasset.localhost/foo.png</p><img src="http://richasset.localhost/foo.png"><video src=\'http://richasset.localhost/bar.mp4\'></video>'
    expect(toStoredHtml(html)).toBe(
      '<p>原文 http://richasset.localhost/foo.png</p><img src="assets/foo.png"><video src=\'assets/bar.mp4\'></video>',
    )
  })

  it('支持带多个点的本地文件名', () => {
    expect(toEditorHtml('<img src="assets/a.b.c.png">', toUrl)).toBe(
      '<img src="http://richasset.localhost/a.b.c.png">',
    )
  })
})
