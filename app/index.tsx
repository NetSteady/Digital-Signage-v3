import SignageDisplay from "../components/SignageDisplay";

export default function App() {
  return (
    <SignageDisplay
      refreshInterval={1} // Refresh every 1 minute
      retryDelay={60} // Retry failed requests after 60 seconds
    />
  );
}
