import express from "npm:express";
import cors from "npm:cors";
import Stripe from "npm:stripe";
import admin from "npm:firebase-admin";

// --- 1. FIREBASE INITIALISIERUNG (Einmalig & Sicher) ---
let db;

try {
  const serviceAccountVar = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");

  if (!serviceAccountVar) {
    throw new Error("Umgebungsvariable FIREBASE_SERVICE_ACCOUNT fehlt!");
  }

  const serviceAccount = JSON.parse(serviceAccountVar);

  // WICHTIG: Korrigiert Zeilenumbrüche im Private Key (oft ein Problem bei Env-Vars)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(
      /\\n/g,
      "\n"
    );
  }

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase App erfolgreich initialisiert");
  }

  db = admin.firestore();
} catch (error) {
  console.error(
    "❌ Kritischer Fehler bei der Firebase-Initialisierung:",
    error.message
  );
}

// --- 2. STRIPE & EXPRESS SETUP ---
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY"));
const app = express();

app.use(cors());

// --- 3. STRIPE WEBHOOK ---
// Wichtig: express.raw() muss VOR express.json() kommen, damit die Signatur-Prüfung klappt
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        Deno.env.get("STRIPE_WEBHOOK_SECRET")
      );
    } catch (err) {
      console.error(`❌ Webhook Signatur Fehler: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ Webhook empfangen:", event.type);

    // ERSTKAUF
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.client_reference_id;

      if (uid) {
        try {
          const sessionWithItems = await stripe.checkout.sessions.retrieve(
            session.id,
            { expand: ["line_items.data.price.product"] }
          );

          const product = sessionWithItems.line_items.data[0].price.product;
          const creditsToAdd = parseInt(product.metadata.credits || "0");
          const isUnlimited = product.metadata.isUnlimited === "true";
          const planName = product.metadata.planName || product.name;

          await updateFirestoreUser(uid, {
            creditsToAdd,
            isUnlimited,
            planName,
            subscriptionId: session.subscription,
            customerId: session.customer,
            invoiceId: session.invoice,
            isRenewal: false,
          });
        } catch (err) {
          console.error("❌ Fehler bei Erstkauf:", err);
        }
      }
    }

    // VERLÄNGERUNG
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      if (invoice.billing_reason === "subscription_cycle") {
        try {
          const subscription = await stripe.subscriptions.retrieve(
            invoice.subscription
          );
          const uid = subscription.metadata.uid;

          if (uid) {
            const product = await stripe.products.retrieve(
              invoice.lines.data[0].price.product
            );
            const creditsToAdd = parseInt(product.metadata.credits || "0");
            const isUnlimited = product.metadata.isUnlimited === "true";
            const planName = product.metadata.planName || product.name;

            await updateFirestoreUser(uid, {
              creditsToAdd,
              isUnlimited,
              planName,
              subscriptionId: invoice.subscription,
              customerId: invoice.customer,
              invoiceId: invoice.id,
              isRenewal: true,
            });
          }
        } catch (err) {
          console.error("❌ Fehler bei Verlängerung:", err);
        }
      }
    }

    // KÜNDIGUNG
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;
      if (uid) {
        await db.collection("users").doc(uid).set(
          {
            credits: 0,
            isUnlimited: false,
            plan: "expired",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        console.log(`🚫 Abo für User ${uid} beendet.`);
      }
    }

    res.json({ received: true });
  }
);

// --- 4. HILFSFUNKTION ---
async function updateFirestoreUser(uid, data) {
  if (!db) return;
  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();

  if (
    doc.exists &&
    doc.data().payments?.some((p) => p.invoiceId === data.invoiceId)
  ) {
    console.log("⚠️ Invoice bereits verarbeitet.");
    return;
  }

  const currentCredits = doc.exists ? doc.data().credits || 0 : 0;
  const newCredits = data.isUnlimited
    ? 999999
    : currentCredits + data.creditsToAdd;

  await userRef.set(
    {
      credits: newCredits,
      isUnlimited: data.isUnlimited,
      plan: data.planName,
      lastPaymentStatus: "active",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      payments: admin.firestore.FieldValue.arrayUnion({
        invoiceId: data.invoiceId,
        credits: data.creditsToAdd,
        date: new Date().toISOString(),
      }),
    },
    { merge: true }
  );
  console.log(`✅ User ${uid} aktualisiert.`);
}

// --- 5. ÜBRIGE API ENDPUNKTE ---
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { uid, email, priceId } = req.body;
    if (!uid || !priceId)
      return res.status(400).json({ error: "Missing data" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      client_reference_id: uid,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { uid } },
      success_url: `https://schriftbot.com/success`,
      cancel_url: `https://schriftbot.com/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) =>
  res.json({ status: "active", system: "deno-deploy" })
);

// Start
const PORT = Deno.env.get("PORT") || 8000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
