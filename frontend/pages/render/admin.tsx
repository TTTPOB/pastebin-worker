import ReactDOM from "react-dom/client"
import React from "react"
import { HeroUIProvider } from "@heroui/react"
import { AdminPanel } from "../AdminPanel.js"

const root = ReactDOM.createRoot(document.getElementById("root")!)

root.render(
  <React.StrictMode>
    <HeroUIProvider>
      <AdminPanel />
    </HeroUIProvider>
  </React.StrictMode>,
)
