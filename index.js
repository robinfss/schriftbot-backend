require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// --- 1. FIREBASE INITIALISIERUNG ---
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

app.use(cors());

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
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ Webhook empfangen:", event.type);

    // --- FALL 1: DER ERSTKAUF (Sicherster Weg für die erste Gutschrift) ---
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.client_reference_id; // Deine UID aus dem Frontend!

      if (!uid) {
        console.error("❌ Keine UID in Checkout Session gefunden");
        return res.json({ received: true });
      }

      try {
        // Hol die Produktdaten (Credits) über die Line Items der Session
        const sessionWithItems = await stripe.checkout.sessions.retrieve(
          session.id,
          {
            expand: ["line_items.data.price.product"],
          }
        );

        const product = sessionWithItems.line_items.data[0].price.product;
        const creditsToAdd = parseInt(product.metadata.credits || "0");
        const isUnlimited = product.metadata.isUnlimited === "true";
        const planName = product.metadata.planName || product.name;

        console.log(
          `🌟 Erster Kauf: Gutschrift für ${uid} (${creditsToAdd} Credits)`
        );

        await updateFirestoreUser(uid, {
          creditsToAdd,
          isUnlimited,
          planName,
          subscriptionId: session.subscription,
          customerId: session.customer,
          invoiceId: session.invoice, // Wichtig für Idempotenz
        });
      } catch (err) {
        console.error("❌ Fehler bei Erstgutschrift:", err);
      }
    }

    // --- FALL 2: MONATLICHE VERLÄNGERUNG (Wenn das Abo weiterläuft) ---
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      // Wir ignorieren die allererste Rechnung, da die schon oben (Fall 1) erledigt wurde
      // (Verhindert doppelte Gutschrift beim Erstkauf)
      if (invoice.billing_reason === "subscription_create") {
        console.log(
          "ℹ️ Erst-Rechnung: Wird von checkout.session.completed verarbeitet."
        );
        return res.json({ received: true });
      }

      try {
        const uid = invoice.subscription_details?.metadata?.uid;
        if (!uid) return res.json({ received: true });

        const product = await stripe.products.retrieve(
          invoice.lines.data[0].price.product
        );

        await updateFirestoreUser(uid, {
          creditsToAdd: parseInt(product.metadata.credits || "0"),
          isUnlimited: product.metadata.isUnlimited === "true",
          planName: product.metadata.planName || product.name,
          subscriptionId: invoice.subscription,
          customerId: invoice.customer,
          invoiceId: invoice.id,
        });
      } catch (err) {
        console.error("❌ Fehler bei Verlängerung:", err);
      }
    }

    // --- FALL 3: ABO GEKÜNDIGT ---
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;

      console.log(`🚫 Abo gekündigt für User: ${uid}`);

      if (uid) {
        try {
          await db.collection("users").doc(uid).set(
            {
              credits: 0,
              isUnlimited: false,
              plan: "expired",
              lastPaymentStatus: "canceled",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          console.log(`✅ Abo für User ${uid} beendet. Zugriff entzogen.`);
        } catch (err) {
          console.error("❌ Firestore Error (subscription.deleted):", err);
        }
      }
    }

    res.json({ received: true });
  }
);

// --- HILFSFUNKTION FÜR FIRESTORE (Damit der Code sauber bleibt) ---
async function updateFirestoreUser(uid, data) {
  const userRef = db.collection("users").doc(uid);

  // Idempotenz-Check: Wurde diese Rechnung schon verarbeitet?
  const doc = await userRef.get();
  if (
    doc.exists &&
    doc.data().payments?.some((p) => p.sessionId === data.invoiceId)
  ) {
    console.log(`⚠️ Invoice ${data.invoiceId} bereits verarbeitet.`);
    return;
  }

  await userRef.set(
    {
      credits: data.isUnlimited
        ? 999999
        : admin.firestore.FieldValue.increment(data.creditsToAdd),
      isUnlimited: data.isUnlimited,
      plan: data.planName,
      lastPaymentStatus: "active",
      subscriptionId: data.subscriptionId,
      stripeCustomerId: data.customerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      payments: admin.firestore.FieldValue.arrayUnion({
        sessionId: data.invoiceId,
        amount: "subscription_payment",
        date: new Date().toISOString(),
        status: "completed",
      }),
    },
    { merge: true }
  );

  console.log(`✅ Firestore erfolgreich aktualisiert für User: ${uid}`);
}
// --- 4. JSON MIDDLEWARE ---
app.use(express.json());

// --- 5. CHECKOUT SESSION ---
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("📥 Checkout Request:", req.body);

    const { uid, email, priceId } = req.body;

    if (!priceId) {
      console.error("❌ Fehlende priceId");
      return res.status(400).json({ error: "Fehlende Price ID" });
    }

    if (!uid || !email) {
      console.error("❌ Fehlende uid oder email");
      return res.status(400).json({ error: "Fehlende User-Daten" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      client_reference_id: uid, // ✅ UID für checkout.session.completed
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { uid }, // ✅ UID für die Subscription
      },
      success_url: `https://schriftbot.com/success`,
      cancel_url: `https://schriftbot.com/`,
    });

    console.log("✅ Session erstellt:", session.id);
    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "active" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
