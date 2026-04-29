// test-gemini.mjs
// Quick test of Gemini 2.5 Flash endpoint

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('GEMINI_API_KEY is not set in the environment.');
  process.exit(1);
}

const apiUrl =
  'https://generativelanguage.googleapis.com/v1/models/' +
  'gemini-2.5-flash:generateContent?key=' +
  apiKey;

async function main() {
  const payload = {
    contents: [
      {
        parts: [{ text: 'Return exactly the digits 123, nothing else.' }],
      },
    ],
  };

  console.log('Calling:', apiUrl);

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  console.log('HTTP status:', response.status, response.statusText);

  const json = await response.json().catch(() => null);
  console.log('Response JSON:', JSON.stringify(json, null, 2));

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log('Model text:', text);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
