import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getFunctions } from 'firebase/functions'

export const firebaseConfig = {
  apiKey: "AIzaSyCb1BmZI6H7rw4fPO72yNJBQHtsfpzwr8M",
  authDomain: "iyora-eg.firebaseapp.com",
  projectId: "iyora-eg",
  storageBucket: "iyora-eg.firebasestorage.app",
  messagingSenderId: "1064818599797",
  appId: "1:1064818599797:web:90b4742b1a38763dcd953c"
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)
