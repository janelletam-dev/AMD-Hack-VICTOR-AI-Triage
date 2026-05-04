import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import PatientView from "./pages/PatientView.jsx";
import ClinicianDashboard from "./pages/ClinicianDashboard.jsx";
import EmrView from "./pages/EmrView.jsx";
import EvidenceReport from "./pages/EvidenceReport.jsx";
import Landing from "./pages/Landing.jsx";

function ViewToggle() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;

  if (path === "/" || path.startsWith("/clinician/report")) return null;

  const isPatient = path.startsWith("/patient");
  const isClinician = path === "/clinician";
  const isEpic = path.startsWith("/clinician/epic");

  if (!isPatient && !isClinician && !isEpic) return null;
  // Hide the route toggle on the patient kiosk: real patients shouldn't see
  // dev-only navigation, and the kiosk view is too dense to fit it cleanly.
  // Add ?dev=1 to override (handy when demoing).
  if (isPatient) {
    const params = new URLSearchParams(location.search);
    if (params.get("dev") !== "1") return null;
  }

  const tabStyle = (active) => ({
    background: active ? "var(--vic-primary)" : "transparent",
    border: "none",
    color: active ? "var(--vic-on-primary)" : "var(--vic-on-surface-variant)",
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: ".08em",
    textTransform: "uppercase",
    cursor: "pointer",
    fontWeight: 600,
  });

  return (
    <div style={{
      // Bottom-center, sitting just above the fixed kiosk/EpicStatus footer.
      // Made compact so it doesn't crowd content on either side.
      position: "fixed", bottom: 84, left: "50%", transform: "translateX(-50%)",
      background: "rgba(21, 27, 45, 0.92)",
      backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(47, 217, 244, 0.25)",
      borderRadius: 999, padding: 3, display: "flex", gap: 2, zIndex: 100,
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
    }}>
      <button onClick={() => navigate("/patient")} style={tabStyle(isPatient)}>/ patient</button>
      <button onClick={() => navigate("/clinician")} style={tabStyle(isClinician)}>/ clinician</button>
      <button onClick={() => navigate("/clinician/epic")} style={tabStyle(isEpic)}>/ epic</button>
    </div>
  );
}

export default function App() {
  return (
    <>
      <ViewToggle />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/patient" element={<PatientView />} />
        <Route path="/clinician" element={<ClinicianDashboard />} />
        <Route path="/clinician/epic" element={<EmrView />} />
        <Route path="/clinician/report" element={<EvidenceReport />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
