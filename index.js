const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Replicate = require("replicate");

const app = express();
app.use(cors({
  origin: ['https://gokturkai.com', 'https://gokturkaicom.netlify.app','https://www.gokturkai.com', 'http://localhost:5173'],
  credentials: true,
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  price_1TKXj4D1DtcsOeYDsAbFlFmW: { credits: 25, name: 'Starter' },
  price_1TKXjdD1DtcsOeYD9CIpOcBf: { credits: 75, name: 'Pro' },
  price_1TKXjzD1DtcsOeYDMBu4wlHm: { credits: 200, name: 'Creator' },
};

// ⚠️ WEBHOOK — express.json'dan ÖNCE
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature hatası:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id;
    const credits = parseInt(session.metadata.credits);

    const { data: profile } = await supabase
      .from('profiles').select('credits').eq('id', userId).single();

    if (profile) {
      await supabase
        .from('profiles')
        .update({ credits: profile.credits + credits })
        .eq('id', userId);
      console.log(`✅ ${userId} kullanıcısına ${credits} kredi eklendi`);
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "10mb" }));

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Token gerekli" });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Geçersiz token" });
  req.user = user;
  next();
};

const adminMiddleware = async (req, res, next) => {
  const { data: profile } = await supabase
    .from("profiles").select("is_admin").eq("id", req.user.id).single();
  if (!profile?.is_admin)
    return res.status(403).json({ error: "Admin yetkisi gerekli" });
  next();
};

app.get("/", (req, res) => res.json({ message: "Server çalışıyor!" }));

app.post("/auth/register", async (req, res) => {
  const { email, password, full_name } = req.body;
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { data: { full_name } },
  });
  if (error) return res.status(400).json({ message: error.message });
  await supabase.from("profiles").insert({
    id: data.user.id, email, full_name, credits: 3, is_admin: false,
  });
  res.json({
    user: { id: data.user.id, email, full_name, credits: 3, is_admin: false, created_at: data.user.created_at },
    token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
  });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ message: error.message });
  const { data: profile } = await supabase
    .from("profiles").select("*").eq("id", data.user.id).single();
  res.json({
    user: {
      id: data.user.id, email: data.user.email,
      full_name: profile?.full_name, credits: profile?.credits ?? 0,
      is_admin: profile?.is_admin ?? false, created_at: data.user.created_at,
    },
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  let { data: profile } = await supabase
    .from("profiles").select("*").eq("id", req.user.id).single();

  if (!profile) {
    const full_name = req.user.user_metadata?.full_name ?? req.user.email?.split('@')[0] ?? 'Kullanıcı';
    const { data: newProfile } = await supabase
      .from("profiles")
      .insert({ id: req.user.id, email: req.user.email, full_name, credits: 3, is_admin: false })
      .select().single();
    profile = newProfile;
  }

  res.json({
    id: req.user.id, email: req.user.email,
    full_name: profile?.full_name, credits: profile?.credits ?? 0,
    is_admin: profile?.is_admin ?? false, created_at: req.user.created_at,
  });
});

app.post("/auth/logout", authMiddleware, async (req, res) => {
  await supabase.auth.signOut();
  res.json({ message: "Çıkış yapıldı" });
});

app.get("/templates", async (req, res) => {
  const { data, error } = await supabase
    .from("templates").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/templates", authMiddleware, adminMiddleware, async (req, res) => {
  const { name, category, prompt, image_url } = req.body;
  const { data, error } = await supabase
    .from("templates").insert({ name, category, prompt, image_url }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/templates/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const { name, category, prompt, image_url } = req.body;
  const { data, error } = await supabase
    .from("templates").update({ name, category, prompt, image_url })
    .eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/templates/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabase.from("templates").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Silindi" });
});

app.post("/generate", authMiddleware, async (req, res) => {
  try {
    const { templateId, userPhotoBase64 } = req.body;
    const { data: profile } = await supabase
      .from("profiles").select("credits").eq("id", req.user.id).single();
    if (!profile || profile.credits < 1)
      return res.status(402).json({ message: "Yetersiz kredi" });

    const { data: template, error: templateError } = await supabase
      .from("templates").select("*").eq("id", templateId).single();
    if (templateError) return res.status(404).json({ error: "Template bulunamadı" });

    const fileName = `uploads/${Date.now()}.jpg`;
    const buffer = Buffer.from(userPhotoBase64, "base64");
    const { error: uploadError } = await supabase.storage
      .from("user-uploads").upload(fileName, buffer, { contentType: "image/jpeg" });
    if (uploadError)
      return res.status(500).json({ error: "Fotoğraf yüklenemedi: " + uploadError.message });

    const { data: { publicUrl } } = supabase.storage.from("user-uploads").getPublicUrl(fileName);

    const output = await replicate.run(
      "tencentarc/photomaker:ddfc2b08d209f9fa8c1eca692712918bd449f695dabb4a958da31802a9570fe4",
      {
        input: {
          prompt: template.prompt,
          input_image: publicUrl,
          style_name: "Photographic (Default)",
          num_outputs: 1,
        },
      },
    );

    const stream = output[0];
    const chunks = [];
    for await (const chunk of stream) { chunks.push(chunk); }
    const resultBuffer = Buffer.concat(chunks);

    const resultFileName = `results/${Date.now()}.jpg`;
    await supabase.storage
      .from("user-uploads").upload(resultFileName, resultBuffer, { contentType: "image/jpeg" });
    const { data: { publicUrl: resultUrl } } = supabase.storage
      .from("user-uploads").getPublicUrl(resultFileName);

    await supabase.from("profiles").update({ credits: profile.credits - 1 }).eq("id", req.user.id);
    await supabase.from("generations").insert({
      user_id: req.user.id, template_id: templateId, result_url: resultUrl,
    });

    res.json({ resultUrl });
  } catch (err) {
    console.error('Generate hatası:', err);
    return res.status(500).json({ message: 'Görsel üretilemedi, tekrar dene' });
  }
});

app.get("/my-generations", authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from("generations").select("*, template:templates(*)")
    .eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/stats", authMiddleware, adminMiddleware, async (req, res) => {
  const { count: totalTemplates } = await supabase
    .from("templates").select("*", { count: "exact", head: true });
  const { count: totalGenerations } = await supabase
    .from("generations").select("*", { count: "exact", head: true });
  const { count: totalUsers } = await supabase
    .from("profiles").select("*", { count: "exact", head: true });

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count: thisMonthGenerations } = await supabase
    .from("generations").select("*", { count: "exact", head: true })
    .gte("created_at", startOfMonth.toISOString());

  const { data: categoryStats } = await supabase.from("templates").select("category");
  const categories = categoryStats?.reduce((acc, t) => {
    acc[t.category] = (acc[t.category] || 0) + 1;
    return acc;
  }, {}) ?? {};

  const { data: topTemplates } = await supabase
    .from("generations").select("template_id, templates(name)").limit(100);

  const templateCounts = topTemplates?.reduce((acc, g) => {
    const id = g.template_id;
    const name = g.templates?.name ?? "Bilinmiyor";
    if (!acc[id]) acc[id] = { name, count: 0 };
    acc[id].count++;
    return acc;
  }, {}) ?? {};

  const topTemplate = Object.values(templateCounts).sort((a, b) => b.count - a.count)[0];

  res.json({
    totalTemplates: totalTemplates ?? 0,
    totalGenerations: totalGenerations ?? 0,
    totalUsers: totalUsers ?? 0,
    thisMonthGenerations: thisMonthGenerations ?? 0,
    categories,
    topTemplate: topTemplate ?? null,
  });
});

app.get("/my-stats", authMiddleware, async (req, res) => {
  const { count: totalGenerations } = await supabase
    .from("generations").select("*", { count: "exact", head: true })
    .eq("user_id", req.user.id);

  const { data: gens } = await supabase
    .from("generations").select("template_id, templates(name)")
    .eq("user_id", req.user.id);

  const templateCounts = gens?.reduce((acc, g) => {
    const id = g.template_id;
    const name = g.templates?.name ?? "Bilinmiyor";
    if (!acc[id]) acc[id] = { name, count: 0 };
    acc[id].count++;
    return acc;
  }, {}) ?? {};

  const favoriteTemplate = Object.values(templateCounts).sort((a, b) => b.count - a.count)[0];

  res.json({
    totalGenerations: totalGenerations ?? 0,
    favoriteTemplate: favoriteTemplate?.name ?? "-",
  });
});

app.post('/create-checkout-session', authMiddleware, async (req, res) => {
  const { priceId } = req.body;
  if (!PLANS[priceId]) return res.status(400).json({ message: 'Geçersiz plan' });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'payment',
    success_url: `${process.env.FRONTEND_URL}/app?payment=success`,
    cancel_url: `${process.env.FRONTEND_URL}/pricing?payment=cancelled`,
    metadata: {
      user_id: req.user.id,
      price_id: priceId,
      credits: PLANS[priceId].credits,
    },
  });

  res.json({ url: session.url });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portunda çalışıyor`));