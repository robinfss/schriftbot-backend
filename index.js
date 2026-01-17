import express from "npm:express";
import cors from "npm:cors";
import Stripe from "npm:stripe";
import admin from "npm:firebase-admin";

// --- 1. FIREBASE INITIALISIERUNG ---
let db;

try {
  const serviceAccountVar = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!serviceAccountVar) throw new Error("Umgebungsvariable fehlt!");

  const serviceAccount = JSON.parse(serviceAccountVar);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(
      /\\n/g,
      "\n"
    );
  }

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }

  db = admin.firestore();

  // 🔥 DER FIX FÜR DENO DEPLOY:
  // Wir zwingen Firestore, kein gRPC zu nutzen und leere Felder zu ignorieren
  db.settings({
    ignoreUndefinedProperties: true,
    ssl: true,
  });

  console.log(
    `✅ Firebase (REST-Mode) für ${serviceAccount.project_id} bereit`
  );
} catch (error) {
  console.error("❌ Firebase Init Fehler:", error.message);
}

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY"));
const app = express();
app.use(cors());

// --- 2. WEBHOOK ---
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = await stripe.webhooks.constructEventAsync(
        req.body,
        sig,
        Deno.env.get("STRIPE_WEBHOOK_SECRET")
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`🔔 Event: ${event.type}`);

    // Wir führen die DB-Logik aus und WARTEN darauf, bevor wir res.json schicken
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const uid = session.client_reference_id;
        if (uid) {
          const sessionWithItems = await stripe.checkout.sessions.retrieve(
            session.id,
            { expand: ["line_items.data.price.product"] }
          );
          const product = sessionWithItems.line_items.data[0].price.product;

          // WICHTIG: await hier erzwingt, dass die TLS Verbindung gehalten wird
          await updateFirestoreUser(uid, {
            creditsToAdd: parseInt(product.metadata.credits || "0"),
            isUnlimited: product.metadata.isUnlimited === "true",
            planName: product.metadata.planName || product.name,
            subscriptionId: session.subscription,
            customerId: session.customer,
            invoiceId: session.invoice,
          });
        }
      }

      if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        if (invoice.billing_reason === "subscription_cycle") {
          const subscription = await stripe.subscriptions.retrieve(
            invoice.subscription
          );
          const uid = subscription.metadata.uid;
          if (uid) {
            const product = await stripe.products.retrieve(
              invoice.lines.data[0].price.product
            );
            await updateFirestoreUser(uid, {
              creditsToAdd: parseInt(product.metadata.credits || "0"),
              isUnlimited: product.metadata.isUnlimited === "true",
              planName: product.metadata.planName || product.name,
              invoiceId: invoice.id,
            });
          }
        }
      }
    } catch (err) {
      console.error("❌ Event Processing Error:", err.message);
    }

    // Kleiner Puffer, um sicherzustellen, dass die Pakete gesendet wurden
    await new Promise((r) => setTimeout(r, 100));
    res.json({ received: true });
  }
);

// --- 3. HILFSFUNKTION ---
async function updateFirestoreUser(uid, data) {
  if (!db) throw new Error("DB nicht initialisiert");

  try {
    console.log(`📡 Schreibe in Firestore für UID: ${uid}...`);
    const userRef = db.collection("users").doc(uid);

    // Wir nutzen hier set mit merge
    await userRef.set(
      {
        credits: data.isUnlimited
          ? 999999
          : admin.firestore.FieldValue.increment(data.creditsToAdd || 0),
        isUnlimited: data.isUnlimited || false,
        plan: data.planName || "Plan",
        lastPaymentStatus: "active",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        payments: admin.firestore.FieldValue.arrayUnion({
          invoiceId: data.invoiceId,
          date: new Date().toISOString(),
        }),
      },
      { merge: true }
    );

    console.log(`✅ Firestore erfolgreich aktualisiert für ${uid}`);
  } catch (error) {
    // Wenn es hier kracht, sehen wir jetzt genau warum
    console.error(`❌ Firestore Schreibfehler: ${error.message}`);
    throw error;
  }
}

// RESTLICHE ENDPUNKTE (create-checkout-session etc. wie vorher)
app.use(express.json());
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { uid, email, priceId } = req.body;
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

app.get("/", (req, res) => res.send("Deno Backend Active"));

const PORT = Deno.env.get("PORT") || 8000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
