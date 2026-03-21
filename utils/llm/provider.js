/**
 * Base LLM Provider interface
 * Extend this class to add support for different LLM providers
 */
class LLMProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  get name() {
    throw new Error('Provider must implement name getter');
  }

  /**
   * Transcribe a historical document image
   * @param {Buffer} imageBuffer - The image data
   * @param {string} mimeType - The image MIME type (e.g., 'image/jpeg')
   * @param {object} options - Additional options
   * @returns {Promise<{transcription: string, metadata: object, notes: string}>}
   */
  async transcribeDocument(imageBuffer, mimeType, options = {}) {
    throw new Error('Provider must implement transcribeDocument method');
  }

  /**
   * Build the prompt for document transcription
   * @param {object} options - Additional context/options
   * @returns {string}
   */
  buildTranscriptionPrompt(options = {}) {
    return `You are an expert historical document transcriber. Analyze this image of a historical document and provide:

1. **Transcription**: A complete, accurate transcription of all visible text in the document. Preserve original spelling, punctuation, and formatting as much as possible. Use [illegible] for text that cannot be read, and [?] after words you're uncertain about.

2. **Metadata**: Extract the following information if available:
   - title: A descriptive title for this document
   - date_created: The date on the document (in YYYY-MM-DD format if possible, or as written)
   - author: Who wrote or created the document
   - recipient: Who the document was addressed to (if applicable)
   - location: Where the document was created or relates to
   - document_type: The type of document (letter, legal document, ledger, manifest, etc.)
   - language: The primary language of the document
   - condition: Brief description of the document's physical condition

3. **Notes**: Any observations about the document that might help researchers, such as:
   - Unusual features or markings
   - Historical context
   - Difficulties in transcription
   - Related documents or references mentioned

Respond in the following JSON format:
{
  "transcription": "full text here...",
  "metadata": {
    "title": "...",
    "date_created": "...",
    "author": "...",
    "recipient": "...",
    "location": "...",
    "document_type": "...",
    "language": "...",
    "condition": "..."
  },
  "notes": "..."
}

Only include metadata fields that you can reasonably determine from the document. Omit fields that are not applicable or cannot be determined.`;
  }

  /**
   * Parse the LLM response into structured data
   * @param {string} response - Raw LLM response
   * @returns {{transcription: string, metadata: object, notes: string}}
   */
  parseResponse(response) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          transcription: parsed.transcription || '',
          metadata: parsed.metadata || {},
          notes: parsed.notes || ''
        };
      }
    } catch (err) {
      console.error('Failed to parse LLM response as JSON:', err.message);
    }

    // Fallback: return raw response as transcription
    return {
      transcription: response,
      metadata: {},
      notes: 'Failed to parse structured response from LLM'
    };
  }
}

module.exports = LLMProvider;
