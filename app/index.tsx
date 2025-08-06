import SignageDisplay from "../components/SignageDisplay";

export default function App() {
  return (
    <SignageDisplay
      refreshInterval={0.1} // Check API every 0.1 minutes
      retryDelay={60} // Retry failed requests after 60 seconds
    />
  );
}
