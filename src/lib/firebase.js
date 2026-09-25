import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getFunctions } from 'firebase/functions'

export const firebaseConfig = {
  apiKey: "AIzaSyDVQx2fSTQw8qDqJVQfrxJwcAjRhaDmuVw",
  authDomain: "iyora-help.firebaseapp.com",
  projectId: "iyora-help",
  storageBucket: "iyora-help.firebasestorage.app",
  messagingSenderId: "377101352404",
  appId: "1:377101352404:web:13f48483d107fc12b26a41",
  measurementId: "G-7N94M60RZM"
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)
export const functions = getFunctions(app)
