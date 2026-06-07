import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCtQbVm91_lsmzz2XcX60bhUCYH0CjRb_E",
    authDomain: "memosummary.firebaseapp.com",
    projectId: "memosummary",
    storageBucket: "memosummary.firebasestorage.app",
    messagingSenderId: "368924924231",
    appId: "1:368924924231:web:db54991db4a9d6afe5d462",
    measurementId: "G-798K8NH74R"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
