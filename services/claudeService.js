const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

let _client = null;
const getClient = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
};

const parseAIResponse = (text) => {
  try {
    const cleanText = text.trim();

    if (cleanText.startsWith('[') && cleanText.endsWith(']')) {
      const parsed = JSON.parse(cleanText);
      if (Array.isArray(parsed)) return { parsed, error: null };
    }

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) return { parsed, error: null };
    }

    return { parsed: [], error: null };
  } catch (e) {
    return { parsed: [], error: `Parse error: ${e.message}` };
  }
};

const analyzeSingleImage = async (base64Data, pageNumber, modelName, prompt) => {
  const mimeMatch = base64Data.match(/^data:(image\/[a-z]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const base64Part = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;

  const response = await getClient().messages.create({
    model: modelName,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64Part }
          },
          { type: 'text', text: prompt }
        ]
      }
    ]
  });

  const text = response.content[0]?.text || '';
  return parseAIResponse(text);
};

exports.analyzeImage = async (imageBase64, pageNumber, modelName = 'claude-sonnet-4-6', prompt) => {
  if (!prompt) throw new Error('Prompt is required from frontend');

  try {
    return await analyzeSingleImage(imageBase64, pageNumber, modelName, prompt);
  } catch (error) {
    console.error(`Claude error for page ${pageNumber}:`, error.message);
    return { parsed: [], error: error.message };
  }
};

exports.analyzeImagesUltraFast = async (images, onProgress, modelName = 'claude-sonnet-4-6', prompt) => {
  if (!prompt) throw new Error('Prompt is required from frontend');

  console.log(`\nClaude PARALLEL ANALYSIS - ${images.length} images, model: ${modelName}`);

  const results = new Array(images.length).fill(null);
  let completedCount = 0;

  const MAX_CONCURRENT = 5;

  const processImage = async (image, index) => {
    try {
      const result = await analyzeSingleImage(image.base64, image.pageNumber, modelName, prompt);
      results[index] = { parsed: result.parsed, raw: JSON.stringify(result.parsed), error: result.error };
      completedCount++;
      if (onProgress) onProgress(completedCount, images.length, image.pageNumber);
      console.log(`  Page ${image.pageNumber} - ${result.parsed.length} items`);
    } catch (error) {
      console.error(`  Page ${image.pageNumber} failed: ${error.message}`);
      results[index] = { parsed: [], raw: `Error: ${error.message}`, error: error.message };
      completedCount++;
      if (onProgress) onProgress(completedCount, images.length, image.pageNumber);
    }
  };

  for (let i = 0; i < images.length; i += MAX_CONCURRENT) {
    const batch = images.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map((image, batchIndex) => processImage(image, i + batchIndex)));
    if (i + MAX_CONCURRENT < images.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
};

exports.getAvailableModels = () => CLAUDE_MODELS;
exports.isClaudeModel = (modelName) => CLAUDE_MODELS.includes(modelName);
