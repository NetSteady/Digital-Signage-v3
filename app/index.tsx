import SignageDisplay from "../components/SignageDisplay";

export default function App() {
  return (
    <SignageDisplay
      refreshInterval={30} // Refresh every 30 minutes
      retryDelay={60} // Retry failed requests after 60 seconds
    />
  );
}
