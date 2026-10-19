import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test, type TestContext } from "node:test";

// @ts-ignore TS5097: Native Node tests load this TypeScript source without a build step.
import { ProviderError, recognize, tryOn, validateRecognitionInput, validateTryOnInput } from "./providers.ts";

const env = {
  AIYI_RECOGNITION_KEY: "recognition-test-only-key",
  AIYI_IMAGE_KEY: "image-test-only-key",
};

type RecognitionRequest = {
  model: string;
  response_format: unknown;
  thinking: unknown;
  max_tokens: number;
  max_completion_tokens?: unknown;
  messages: Array<{ content: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > }>;
};

function imageBytes(mime = "image/png", marker = 1, length = 32): Buffer {
  const bytes = Buffer.alloc(length, marker);
  const signature = mime === "image/jpeg"
    ? Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    : mime === "image/webp"
      ? Buffer.from("RIFF\x18\x00\x00\x00WEBP", "binary")
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  signature.copy(bytes);
  return bytes;
}

function dataUrl(mime = "image/png", marker = 1, length = 32): string {
  return `data:${mime};base64,${imageBytes(mime, marker, length).toString("base64")}`;
}

const person = dataUrl("image/jpeg", 1);
const outputImage = dataUrl("image/png", 9);
const categories = ["top", "outerwear", "bottom", "shoes", "bag"] as const;
const items = categories.map((category, index) => ({
  name: `reference ${category}`,
  category,
  image: dataUrl(index === 4 ? "image/webp" : "image/png", index + 2),
}));

function rawGarment(type = "shirt", overrides: Record<string, unknown> = {}) {
  return {
    name: "蓝色上衣", type, colors: ["navy"], primary_color: "navy", season: ["spring"],
    material: "棉", notes: "保留纽扣", confidence: 0.9, bbox: [0.1, 0.2, 0.8, 0.9],
    ...overrides,
  };
}

function recognitionResponse(garments: unknown[], finishReason = "stop"): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: {
    content: JSON.stringify({ garments }),
  } }] });
}

function imageResponse(encoded = outputImage.split(",")[1]): Response {
  return Response.json({ data: [{ b64_json: encoded }] });
}

function mockFetch(t: TestContext, handler: (request: Request) => Promise<Response> | Response) {
  return t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  });
}

function preventFetch(t: TestContext) {
  return mockFetch(t, () => { throw new Error("Invalid input must not call a provider"); });
}

function isProviderError(error: unknown): boolean {
  assert.ok(error instanceof ProviderError, `Expected ProviderError, received ${String(error)}`);
  assert.equal(typeof error.code, "string");
  assert.ok(error.code.length > 0);
  assert.ok(!error.message.includes(env.AIYI_RECOGNITION_KEY));
  assert.ok(!error.message.includes(env.AIYI_IMAGE_KEY));
  return true;
}

test("pure validators accept valid inputs without credentials or HTTP", (t) => {
  const fetch = preventFetch(t);
  assert.deepEqual(validateRecognitionInput({ image: person }), { image: person });
  assert.deepEqual(validateTryOnInput({ modelImage: person, items, prompt: "  保留背景  " }), {
    modelImage: person, items, prompt: "保留背景",
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("pure validators reject invalid inputs without HTTP", (t) => {
  const fetch = preventFetch(t);
  for (const input of [null, {}, { image: "https://example.com/image.png" }]) {
    assert.throws(() => validateRecognitionInput(input), isProviderError);
  }
  for (const input of [
    null,
    { modelImage: person, items: [] },
    { modelImage: person, items: [items[0], items[0]] },
    { modelImage: person, items: [{ ...items[0], image: "https://example.com/image.png" }] },
  ]) {
    assert.throws(() => validateTryOnInput(input), isProviderError);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("already-aborted requests never call either upstream", async (t) => {
  const fetch = preventFetch(t);
  const signal = AbortSignal.abort();
  const cancelled = (error: unknown) => {
    isProviderError(error);
    assert.equal((error as ProviderError).code, "cancelled");
    return true;
  };
  await assert.rejects(recognize({ image: person }, env, signal), cancelled);
  await assert.rejects(tryOn({ modelImage: person, items }, env, signal), cancelled);
  assert.equal(fetch.mock.callCount(), 0);
});

test("missing provider keys are rejected before HTTP", async (t) => {
  const fetch = preventFetch(t);
  const notConfigured = (error: unknown) => {
    isProviderError(error);
    assert.equal((error as ProviderError).code, "not_configured");
    return true;
  };
  for (const key of [undefined, "", "   "]) {
    const missing = { AIYI_RECOGNITION_KEY: key, AIYI_IMAGE_KEY: key };
    await assert.rejects(recognize({ image: person }, missing as Parameters<typeof recognize>[1]), notConfigured);
    await assert.rejects(tryOn({ modelImage: person, items }, missing as Parameters<typeof tryOn>[1]), notConfigured);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("recognition uses the DeepSeek JSON contract and maps all five clothing groups", async (t) => {
  const fetch = mockFetch(t, async (request) => {
    assert.equal(request.url, "https://api.deepseek.com/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), `Bearer ${env.AIYI_RECOGNITION_KEY}`);
    const body = await request.json() as RecognitionRequest;
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, 4000);
    assert.ok(!("max_completion_tokens" in body));
    const content = body.messages.flatMap((message) => message.content);
    assert.equal(content.find((part) => part.type === "image_url")?.image_url.url, person);
    assert.match(content.filter((part) => part.type === "text").map((part) => part.text).join(" "), /json/i);
    return recognitionResponse(["shirt", "jacket", "pants", "shoes", "bag"].map((type) => rawGarment(type)));
  });
  const result = await recognize({ image: person }, env);
  assert.deepEqual(result.garments.map((garment) => garment.category), [...categories]);
  for (const garment of result.garments) {
    assert.equal(garment.name, "蓝色上衣");
    assert.equal(garment.color, "藏蓝色");
    assert.equal(garment.notes, "保留纽扣");
    assert.equal(garment.confidence, 0.9);
    assert.deepEqual(garment.bbox, [0.1, 0.2, 0.8, 0.9]);
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test("recognition accepts null boxes and falls back from very small boxes", async (t) => {
  mockFetch(t, () => recognitionResponse([
    rawGarment("shirt", { bbox: null }),
    rawGarment("bag", { bbox: [0.4, 0.4, 0.41, 0.41] }),
  ]));
  const result = await recognize({ image: person }, env);
  assert.deepEqual(result.garments.map((garment) => garment.bbox), [null, null]);
});

for (const [label, overrides] of [
  ["unknown type", { type: "spaceship" }],
  ["unknown color", { colors: ["invisible"], primary_color: "invisible" }],
  ["confidence outside range", { confidence: 2 }],
  ["reversed bbox", { bbox: [0.8, 0.2, 0.1, 0.9] }],
  ["bbox outside image", { bbox: [-0.1, 0, 0.8, 0.9] }],
] as const) {
  test(`recognition rejects ${label}`, async (t) => {
    mockFetch(t, () => recognitionResponse([rawGarment("shirt", overrides)]));
    await assert.rejects(recognize({ image: person }, env), isProviderError);
  });
}

test("recognition rejects truncated responses even when the partial JSON parses", async (t) => {
  mockFetch(t, () => recognitionResponse([rawGarment()], "length"));
  await assert.rejects(recognize({ image: person }, env), isProviderError);
});

test("try-on sends the person first and five ordered garments as image[]", async (t) => {
  const fetch = mockFetch(t, async (request) => {
    assert.equal(request.url, "https://gpt.com.se/v1/images/edits");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), `Bearer ${env.AIYI_IMAGE_KEY}`);
    const form = await request.formData();
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("size"), "1024x1536");
    assert.equal(form.get("quality"), "high");
    assert.equal(form.get("output_format"), "png");
    assert.equal(form.get("n"), "1");
    const images = form.getAll("image[]");
    assert.equal(images.length, 6);
    const expected = [person, ...items.map((item) => item.image)];
    for (let index = 0; index < images.length; index += 1) {
      const file = images[index];
      assert.ok(file instanceof Blob);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(expected[index].split(",")[1], "base64"));
    }
    assert.match(String(form.get("prompt")), /bag/i);
    return imageResponse();
  });
  assert.deepEqual(await tryOn({ modelImage: person, items, prompt: "保留背景" }, env), {
    imageDataUrl: outputImage,
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("explicit model overrides reach only their corresponding provider", async (t) => {
  const fetch = mockFetch(t, async (request) => {
    if (request.url.startsWith("https://api.deepseek.com/")) {
      assert.equal((await request.json() as { model: string }).model, "recognition-test-model");
      return recognitionResponse([rawGarment()]);
    }
    assert.equal((await request.formData()).get("model"), "image-test-model");
    return imageResponse();
  });
  await recognize({ image: person }, { ...env, AIYI_RECOGNITION_MODEL: "recognition-test-model" });
  await tryOn({ modelImage: person, items: [items[0]] }, { ...env, AIYI_IMAGE_MODEL: "image-test-model" });
  assert.equal(fetch.mock.callCount(), 2);
});

for (const [label, image] of [
  ["remote image URL", "https://example.com/private-image.png"],
  ["unsupported MIME", "data:image/gif;base64,R0lGODlh"],
  ["mismatched MIME and magic", `data:image/png;base64,${imageBytes("image/jpeg").toString("base64")}`],
  ["non-image bytes", `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`],
  ["oversized decoded input", dataUrl("image/png", 1, 1_900_000)],
] as const) {
  test(`both operations reject ${label} before HTTP`, async (t) => {
    const fetch = preventFetch(t);
    await assert.rejects(recognize({ image }, env), isProviderError);
    await assert.rejects(tryOn({ modelImage: image, items: [items[0]] }, env), isProviderError);
    await assert.rejects(tryOn({ modelImage: person, items: [{ ...items[0], image }] }, env), isProviderError);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

for (const [label, selection] of [
  ["zero garments", []],
  ["six garments", [...items, { ...items[0], name: "sixth garment" }]],
  ["duplicate categories", [items[0], { ...items[0], name: "another top" }]],
] as const) {
  test(`try-on rejects ${label} before HTTP`, async (t) => {
    const fetch = preventFetch(t);
    await assert.rejects(tryOn({ modelImage: person, items: [...selection] }, env), isProviderError);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

test("remote-only image results are rejected without downloading the URL", async (t) => {
  const fetch = mockFetch(t, () => Response.json({ data: [{ url: "https://example.com/output.png" }] }));
  await assert.rejects(tryOn({ modelImage: person, items: [items[0]] }, env), isProviderError);
  assert.equal(fetch.mock.callCount(), 1);
});

test("generated bytes must have supported image magic", async (t) => {
  mockFetch(t, () => imageResponse(Buffer.from("plain text result").toString("base64")));
  await assert.rejects(tryOn({ modelImage: person, items: [items[0]] }, env), isProviderError);
});

test("generated decoded image is limited to 8 MiB", async (t) => {
  const encoded = imageBytes("image/png", 1, 8 * 1024 * 1024 + 1).toString("base64");
  mockFetch(t, () => imageResponse(encoded));
  await assert.rejects(tryOn({ modelImage: person, items: [items[0]] }, env), isProviderError);
});

function excessiveStream(chunkSize: number, totalChunks: number) {
  const state = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (state.pulls > totalChunks) {
        controller.close();
      } else {
        controller.enqueue(new Uint8Array(chunkSize).fill(32));
      }
    },
  });
  return { state, response: new Response(stream, { headers: { "content-type": "application/json" } }) };
}

test("recognition enforces its 512 KiB response limit while streaming", async (t) => {
  const { state, response } = excessiveStream(256 * 1024, 20);
  mockFetch(t, () => response);
  await assert.rejects(recognize({ image: person }, env), isProviderError);
  assert.ok(state.pulls <= 4, `Read ${state.pulls} chunks instead of stopping at the response limit`);
});

test("try-on enforces its 14 MiB response limit while streaming", async (t) => {
  const { state, response } = excessiveStream(1024 * 1024, 40);
  mockFetch(t, () => response);
  await assert.rejects(tryOn({ modelImage: person, items: [items[0]] }, env), isProviderError);
  assert.ok(state.pulls <= 16, `Read ${state.pulls} chunks instead of stopping at the response limit`);
});

test("provider error responses never reveal either configured credential", async (t) => {
  mockFetch(t, () => Response.json({ error: { message: `${env.AIYI_RECOGNITION_KEY} ${env.AIYI_IMAGE_KEY}` } }, { status: 401 }));
  await assert.rejects(recognize({ image: person }, env), isProviderError);
  await assert.rejects(tryOn({ modelImage: person, items: [items[0]] }, env), isProviderError);
});

for (const status of [301, 302, 307, 308]) {
  test(`both providers reject HTTP ${status} without following or revealing redirect data`, async (t) => {
    const location = "https://redirect.example/private?token=private-redirect-token";
    const bodySecret = "private-upstream-body-detail";
    const fetch = mockFetch(t, (request) => {
      assert.equal(request.redirect, "manual");
      return new Response(`${bodySecret} ${env.AIYI_RECOGNITION_KEY} ${env.AIYI_IMAGE_KEY}`, {
        status, headers: { Location: location },
      });
    });
    const rejectsSafely = (error: unknown) => {
      isProviderError(error);
      const message = (error as ProviderError).message;
      assert.ok(!message.includes(location));
      assert.ok(!message.includes("private-redirect-token"));
      assert.ok(!message.includes(bodySecret));
      return true;
    };
    await assert.rejects(recognize({ image: person }, env), rejectsSafely);
    assert.equal(fetch.mock.callCount(), 1);
    await assert.rejects(tryOn({ modelImage: person, items: [items[0]] }, env), rejectsSafely);
    assert.equal(fetch.mock.callCount(), 2, "Each operation must make exactly one HTTP request");
  });
}
