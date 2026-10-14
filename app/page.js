import ChatWidget from "./components/ChatWidget";

export default function Home() {
  return (
    <main className="page-backdrop">
      <div>
        <h1>Welcome to ForecastIQ</h1>
        <p>Click the chat icon in the bottom-right corner to open your AI forecasting assistant.</p>
      </div>
      <ChatWidget />
    </main>
  );
}
