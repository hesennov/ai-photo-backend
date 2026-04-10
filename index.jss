
const express = require('express')
const cors = require('cors')
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const { GoogleGenAI } = require('@google/genai')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

app.get('/', (req, res) => {
  res.json({ message: 'Server çalışıyor!' })
})

app.get('/templates', async (req, res) => {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.post('/generate', async (req, res) => {
  const { templateId, userPhotoBase64 } = req.body

  // 1. Template'in promptunu çek
  const { data: template, error: templateError } = await supabase
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .single()

  if (templateError) return res.status(404).json({ error: 'Template bulunamadı' })

  // 2. Gemini'ye fotoğraf + prompt gönder
  const response = await ai.models.generateContent({
    // model: 'gemini-2.5-flash-image',
    model: 'gemini-2.0-flash-exp',
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: userPhotoBase64
            }
          },
          {
            text: template.prompt
          }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE']
    }
  })

  // 3. Gemini'den gelen görseli al
  let resultBase64 = null
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      resultBase64 = part.inlineData.data
      break
    }
  }

  if (!resultBase64) {
    return res.status(500).json({ error: 'Gemini görsel üretemedi' })
  }

  // 4. Üretilen görseli Supabase'e kaydet
  const resultBuffer = Buffer.from(resultBase64, 'base64')
  const resultFileName = `results/${Date.now()}.jpg`

  await supabase.storage
    .from('user-uploads')
    .upload(resultFileName, resultBuffer, { contentType: 'image/jpeg' })

  const { data: { publicUrl: resultUrl } } = supabase.storage
    .from('user-uploads')
    .getPublicUrl(resultFileName)

  // 5. Sonucu generations tablosuna kaydet
  await supabase.from('generations').insert({
    template_id: templateId,
    result_url: resultUrl
  })

  res.json({ resultUrl })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server ${PORT} portunda çalışıyor`))
