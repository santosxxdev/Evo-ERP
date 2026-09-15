import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getFunctions } from 'firebase/functions'

export const firebaseConfig = {
  apiKey: "AIzaSyBnjBnE0mPyko4ZnLNOXSAawYnn1s9tU1U",
  authDomain: "fir-media-app-815c9.firebaseapp.com",
  projectId: "fir-media-app-815c9",
  storageBucket: "fir-media-app-815c9.firebasestorage.app",
  messagingSenderId: "527669988885",
  appId: "1:527669988885:web:629defa95dee894f97881c",
  measurementId: "G-28QPBYKRQ9"
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)
