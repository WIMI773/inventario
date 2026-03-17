// firestore-service.js
import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc,
  addDoc, updateDoc, deleteDoc, setDoc,
  query, orderBy,
  serverTimestamp, writeBatch,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDrF_RXo_USiffje-v4xCCtFtZSA4e__ls",
  authDomain:        "inventario-23f27.firebaseapp.com",
  projectId:         "inventario-23f27",
  storageBucket:     "inventario-23f27.firebasestorage.app",
  messagingSenderId: "945719325554",
  appId:             "1:945719325554:web:2f2d77d20ef309b8cea3eb"
};

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

const pCol = (uid) => collection(db, "users", uid, "products");
const sCol = (uid) => collection(db, "users", uid, "sales");
const cCol = (uid) => collection(db, "users", uid, "cierres");

// ── TIEMPO REAL ───────────────────────────────────────────
// Llama onProductsChange(array) cada vez que cambian los productos en Firestore
export function subscribeProducts(uid, onProductsChange) {
  const q = query(pCol(uid), orderBy("name"));
  return onSnapshot(q, snap => {
    const prods = snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
    onProductsChange(prods);
  });
}

// Llama onSalesChange(array) cada vez que cambian las ventas en Firestore
export function subscribeSales(uid, onSalesChange) {
  const q = query(sCol(uid), orderBy("date", "desc"));
  return onSnapshot(q, snap => {
    const sls = snap.docs.map(d => {
      const data = d.data();
      const date = data.date?.toDate ? data.date.toDate().toISOString() : (data.date || new Date().toISOString());
      return { firestoreId: d.id, ...data, date };
    });
    onSalesChange(sls);
  });
}

// ── PRODUCTOS ─────────────────────────────────────────────
export async function createProduct(uid, product) {
  const { firestoreId, ...data } = product;
  const ref = await addDoc(pCol(uid), { ...data, createdAt: serverTimestamp() });
  return ref.id;
}
export async function updateProduct(uid, firestoreId, fields) {
  await updateDoc(doc(db, "users", uid, "products", firestoreId), { ...fields, updatedAt: serverTimestamp() });
}
export async function deleteProduct(uid, firestoreId) {
  await deleteDoc(doc(db, "users", uid, "products", firestoreId));
}

// ── VENTAS ────────────────────────────────────────────────
export async function updateSale(uid, firestoreId, fields) {
  await updateDoc(doc(db, "users", uid, "sales", firestoreId), fields);
}
export async function commitSale(uid, sale, products) {
  const batch   = writeBatch(db);
  const saleRef = doc(sCol(uid));
  const { firestoreId: _, ...saleData } = sale;
  batch.set(saleRef, { ...saleData, date: serverTimestamp() });
  for (const item of sale.items) {
    const prod = products.find(p => p.id === item.productId);
    if (!prod?.firestoreId) continue;
    batch.update(doc(db, "users", uid, "products", prod.firestoreId), { stock: prod.stock - item.qty });
  }
  await batch.commit();
  return saleRef.id;
}
export async function cancelSale(uid, sale, products) {
  const batch = writeBatch(db);
  batch.update(doc(db, "users", uid, "sales", sale.firestoreId), { anulada: true });
  for (const item of sale.items) {
    const prod = products.find(p => p.id === item.productId);
    if (!prod?.firestoreId) continue;
    batch.update(doc(db, "users", uid, "products", prod.firestoreId), { stock: prod.stock + item.qty });
  }
  await batch.commit();
}

// ── CIERRES ───────────────────────────────────────────────
export async function createCierre(uid, cierre) {
  await addDoc(cCol(uid), { ...cierre, timestamp: serverTimestamp() });
}