'use strict';

describe('import submission worker', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadModule({ requestedBatchMode = false }) {
    const copyTempAssetToUpload = jest.fn(async (tempName, targetName) => ({
      url: `/uploads/${targetName}`,
      filename: targetName
    }));
    const deleteTempAssets = jest.fn(async () => {});
    const updateSubmissionState = jest.fn(async () => {});
    const createDocument = jest.fn(async () => 101);
    const createTranscriptionJob = jest.fn(async () => 202);
    const saveDatabase = jest.fn(async () => {});
    const markDone = jest.fn(async () => {});

    jest.doMock('../../utils/temp-assets', () => ({
      sanitizeTempFiles: jest.fn((files) => files || []),
      collectTempCleanupFiles: jest.fn((files) => files || []),
      getImportJobPreviewMap: jest.fn(async () => new Map()),
      copyTempAssetToUpload,
      deleteTempAssets
    }));
    jest.doMock('../../database/db', () => ({
      documentsAsync: {
        create: createDocument
      },
      documentCollectionsAsync: {
        setForDocument: jest.fn(async () => {})
      },
      transcriptionJobsAsync: {
        create: createTranscriptionJob
      },
      importJobsAsync: {
        updateSubmissionState,
        markDone
      },
      saveDatabase
    }));

    const module = require('../../utils/import-submission');
    const job = {
      id: 55,
      submit_payload: JSON.stringify({
        sourceImportJobId: null,
        originalName: 'folder.pdf',
        authorizedCollectionIds: [9],
        provider: 'openai',
        providerKeyScope: null,
        userApiKeyId: null,
        requestedByUserId: 7,
        initiatedBy: 'admin',
        temperature: 0.2,
        requestedBatchMode,
        remainingGroups: [{
          label: 'Imported doc',
          tempFiles: ['page1.png', 'page2.png']
        }],
        createdDocs: [],
        batchManifest: [],
        batchJobCreated: false,
        processedCount: 0
      })
    };

    return {
      module,
      job,
      copyTempAssetToUpload,
      deleteTempAssets,
      updateSubmissionState,
      createDocument,
      createTranscriptionJob,
      saveDatabase,
      markDone
    };
  }

  it('creates documents and transcription jobs for queued submission groups', async () => {
    const {
      module,
      job,
      copyTempAssetToUpload,
      createDocument,
      createTranscriptionJob,
      deleteTempAssets,
      markDone
    } = loadModule({ requestedBatchMode: false });

    await module.processImportSubmissionJob(job);

    expect(copyTempAssetToUpload).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Imported doc',
      image_path: '/uploads/folder.png'
    }));
    expect(createTranscriptionJob).toHaveBeenCalledWith(expect.objectContaining({
      document_id: 101,
      additional_image_paths: ['/uploads/folder_page2.png']
    }));
    expect(deleteTempAssets).toHaveBeenCalledWith(['page1.png', 'page2.png']);
    expect(markDone).toHaveBeenCalledWith(55, null);
  });

  it('creates a batch transcription job when requested batch mode is enabled', async () => {
    const {
      module,
      job,
      createTranscriptionJob
    } = loadModule({ requestedBatchMode: true });

    await module.processImportSubmissionJob(job);

    expect(createTranscriptionJob).toHaveBeenCalledWith(expect.objectContaining({
      job_kind: 'batch',
      batch_document_count: 1,
      batch_page_count: 2,
      linked_document_ids: [101]
    }));
  });
});
