import { describe, expect, it } from 'vitest'
import { SseParser } from './sse.js'

describe('the SSE parser', () => {
  it('reads the three lines the server writes per event', () => {
    const parser = new SseParser()
    const frames = parser.push('id: evt-1\nevent: git.commit.landed\ndata: {"id":"evt-1"}\n\n')
    expect(frames).toEqual([{ id: 'evt-1', type: 'git.commit.landed', data: '{"id":"evt-1"}' }])
  })

  it('holds a frame split across chunks until it is whole', () => {
    const parser = new SseParser()
    expect(parser.push('id: evt-1\nevent: a\ndata: {"id":')).toEqual([])
    expect(parser.push('"evt-1"}\n\n')).toEqual([{ id: 'evt-1', type: 'a', data: '{"id":"evt-1"}' }])
  })

  it('reads several frames out of one chunk, in order', () => {
    const parser = new SseParser()
    const frames = parser.push('data: one\n\ndata: two\n\ndata: three\n\n')
    expect(frames.map((frame) => frame.data)).toEqual(['one', 'two', 'three'])
  })

  it('handles CRLF framing', () => {
    const parser = new SseParser()
    expect(parser.push('event: a\r\ndata: x\r\n\r\n')).toEqual([{ id: null, type: 'a', data: 'x' }])
  })

  it('defaults the type to `message`, as the spec says', () => {
    expect(new SseParser().push('data: x\n\n')[0]?.type).toBe('message')
  })

  it('strips exactly one leading space from a value, and no more', () => {
    // `data:  x` is a value of ' x'. Stripping greedily would silently change
    // the JSON of any event whose payload began with whitespace.
    expect(new SseParser().push('data:  x\n\n')[0]?.data).toBe(' x')
    expect(new SseParser().push('data:x\n\n')[0]?.data).toBe('x')
  })

  it('joins multi-line data with newlines rather than dropping all but the last', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')[0]?.data).toBe('a\nb')
  })

  it('ignores comment lines — that is what a heartbeat is', () => {
    const parser = new SseParser()
    expect(parser.push(': keep-alive\n\n')).toEqual([])
    expect(parser.push(': keep-alive\ndata: x\n\n')).toEqual([{ id: null, type: 'message', data: 'x' }])
  })

  it('ignores a field it does not know rather than treating it as data', () => {
    expect(new SseParser().push('retry: 5000\ndata: x\n\n')[0]?.data).toBe('x')
  })

  it('drops a frame with no data at all — a keep-alive is not an event', () => {
    expect(new SseParser().push('id: 1\nevent: ping\n\n')).toEqual([])
  })

  it('survives a chunk boundary inside the blank line that ends a frame', () => {
    const parser = new SseParser()
    expect(parser.push('data: x\n')).toEqual([])
    expect(parser.push('\ndata: y\n\n')).toEqual([
      { id: null, type: 'message', data: 'x' },
      { id: null, type: 'message', data: 'y' },
    ])
  })
})
