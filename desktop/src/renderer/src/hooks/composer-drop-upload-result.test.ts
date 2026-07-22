import { describe, expect, it } from 'vitest'
import {
  collectComposerDropUploadResult,
  shouldReportComposerDropUploadFailure,
  type ComposerDropUploadImportResult
} from './composer-drop-upload-result'

describe('composer drop upload result', () => {
  it('separates imported files and folders while counting skipped or failed paths', () => {
    const results: ComposerDropUploadImportResult[] = [
      { status: 'imported', kind: 'file', destPath: '/repo/.botmux/drops/file.txt' },
      { status: 'imported', kind: 'directory', destPath: '/repo/.botmux/drops/folder' },
      { status: 'skipped' },
      { status: 'failed' }
    ]

    expect(collectComposerDropUploadResult(results)).toEqual({
      filePaths: ['/repo/.botmux/drops/file.txt'],
      folderPaths: ['/repo/.botmux/drops/folder'],
      skippedOrFailed: 2
    })
  })

  it('suppresses failed-upload reporting after a composer loses drop ownership', () => {
    const uploadResult = { skippedOrFailed: 1 }

    expect(shouldReportComposerDropUploadFailure(uploadResult, () => true)).toBe(true)
    expect(shouldReportComposerDropUploadFailure(uploadResult, () => false)).toBe(false)
    expect(shouldReportComposerDropUploadFailure({ skippedOrFailed: 0 }, () => true)).toBe(false)
  })
})
