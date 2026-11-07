import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Body = { prompt?: string; kind?: string }

async function geminiGenerate(
  key: string,
  model: string,
  prompt: string,
  jsonMode: boolean,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`
  const generationConfig: Record<string, unknown> = {
    temperature: jsonMode ? 0.25 : 0.45,
    maxOutputTokens: 8192,
  }
  if (jsonMode) generationConfig.responseMimeType = 'application/json'

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }),
  })
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
    error?: { message?: string }
  }
  if (!res.ok) {
    throw new Error(data.error?.message ?? res.statusText ?? 'Falha na API Gemini.')
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason
    throw new Error(reason ? `Resposta vazia (${reason}).` : 'Resposta vazia da IA.')
  }
  return text
}

async function groqGenerate(
  key: string,
  model: string,
  prompt: string,
  jsonMode: boolean,
): Promise<string> {
  const messages = jsonMode
    ? [
        {
          role: 'user' as const,
          content: `${prompt}\n\nResponde apenas com um único objeto JSON válido, sem texto antes ou depois, sem markdown.`,
        },
      ]
    : [{ role: 'user' as const, content: prompt }]

  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature: jsonMode ? 0.2 : 0.45,
    max_tokens: jsonMode ? 3072 : 4096,
  }
  if (jsonMode) payload.response_format = { type: 'json_object' }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string }
  }
  if (!res.ok) {
    throw new Error(data.error?.message ?? res.statusText ?? 'Falha na API Groq.')
  }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('Resposta vazia da Groq.')
  return text
}

function retryable(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('429') ||
    m.includes('quota') ||
    m.includes('resource_exhausted') ||
    m.includes('rate limit') ||
    m.includes('tokens per minute') ||
    m.includes('tpm') ||
    m.includes('too many requests') ||
    m.includes('503') ||
    m.includes('overloaded') ||
    m.includes('unavailable')
  )
}

function geminiAuthFail(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('api key not valid') ||
    m.includes('invalid api key') ||
    m.includes('permission_denied') ||
    m.includes('403') ||
    m.includes('401')
  )
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Método não permitido.' }), {
        status: 405,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const body = (await req.json()) as Body
    const prompt = String(body.prompt ?? '')
    const jsonMode = body.kind === 'json'
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'Campo prompt em falta.' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const geminiKey = Deno.env.get('GEMINI_API_KEY')?.trim()
    const groqKey = Deno.env.get('GROQ_API_KEY')?.trim()
    const geminiModel = Deno.env.get('GEMINI_MODEL')?.trim() || 'gemini-2.0-flash'
    const groqModel = Deno.env.get('GROQ_MODEL')?.trim() || 'llama-3.1-8b-instant'
    const order = Deno.env.get('FINANCE_LLM_ORDER')?.trim().toLowerCase() ?? ''
    const groqOnly = order === 'groq-only' || order === 'groq_only'
    const groqFirst = order === 'groq-first' || order === 'groq_first'

    if (!geminiKey && !groqKey) {
      return new Response(
        JSON.stringify({
          error:
            'Secrets em falta: na Supabase, Project Settings → Edge Functions → Secrets, define GEMINI_API_KEY e/ou GROQ_API_KEY.',
        }),
        { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const runGemini = () => geminiGenerate(geminiKey!, geminiModel, prompt, jsonMode)
    const runGroq = () => groqGenerate(groqKey!, groqModel, prompt, jsonMode)

    let text: string

    if (groqOnly) {
      if (!groqKey) {
        return new Response(
          JSON.stringify({
            error: 'groq-only: define o secret GROQ_API_KEY na Supabase.',
          }),
          { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } },
        )
      }
      text = await runGroq()
      return new Response(JSON.stringify({ text }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    if (groqFirst && groqKey) {
      try {
        text = await runGroq()
      } catch (e1) {
        const m1 = e1 instanceof Error ? e1.message : String(e1)
        if (geminiKey && (retryable(m1) || geminiAuthFail(m1))) {
          text = await runGemini()
        } else {
          throw e1
        }
      }
    } else if (geminiKey) {
      try {
        text = await runGemini()
      } catch (e1) {
        const m1 = e1 instanceof Error ? e1.message : String(e1)
        if (groqKey && (retryable(m1) || geminiAuthFail(m1))) {
          text = await runGroq()
        } else {
          throw e1
        }
      }
    } else {
      text = await runGroq()
    }

    return new Response(JSON.stringify({ text }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
