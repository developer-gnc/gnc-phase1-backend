const OpenAI = require('openai');

const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];

let _client = null;
const getClient = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
};

const parseResponse = (text) => {
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

const analyzeSingleImage = async (base64Data, modelName, prompt) => {
  const mimeMatch = base64Data.match(/^data:(image\/[a-z]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const base64Part = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;

  const response = await getClient().chat.completions.create({
    model: modelName,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Part}`, detail: 'high' } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  const text = response.choices[0]?.message?.content || '';
  const usage = response.usage || {};
  return {
    ...parseResponse(text),
    usage: {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0
    }
  };
};

exports.analyzeImage = async (imageBase64, pageNumber, modelName = 'gpt-4o', prompt) => {
  if (!prompt) throw new Error('Prompt is required from frontend');
  try {
    return await analyzeSingleImage(imageBase64, modelName, prompt);
  } catch (error) {
    console.error(`OpenAI error for page ${pageNumber}:`, error.message);
    return { parsed: [], error: error.message, usage: { inputTokens: 0, outputTokens: 0 } };
  }
};

exports.analyzeImagesUltraFast = async (images, onProgress, modelName = 'gpt-4o', prompt) => {
  if (!prompt) throw new Error('Prompt is required from frontend');

  console.log(`\nOpenAI ANALYSIS - ${images.length} images, model: ${modelName}`);

  const results = new Array(images.length).fill(null);
  let completedCount = 0;
  const MAX_CONCURRENT = 5;

  const processImage = async (image, index) => {
    try {
      const result = await analyzeSingleImage(image.base64, modelName, prompt);
      results[index] = { parsed: result.parsed, raw: JSON.stringify(result.parsed), error: result.error, usage: result.usage };
      completedCount++;
      if (onProgress) onProgress(completedCount, images.length, image.pageNumber);
    } catch (error) {
      results[index] = { parsed: [], raw: `Error: ${error.message}`, error: error.message, usage: { inputTokens: 0, outputTokens: 0 } };
      completedCount++;
      if (onProgress) onProgress(completedCount, images.length, image.pageNumber);
    }
  };

  for (let i = 0; i < images.length; i += MAX_CONCURRENT) {
    const batch = images.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map((image, batchIndex) => processImage(image, i + batchIndex)));
    if (i + MAX_CONCURRENT < images.length) await new Promise(r => setTimeout(r, 200));
  }

  return results;
};

exports.isOpenAIModel = (modelName) => OPENAI_MODELS.includes(modelName);
