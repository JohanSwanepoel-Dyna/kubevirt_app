import { Page } from "@dynatrace/strato-components-preview/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";
import { VMs } from "./pages/VMs";
import { Logs } from "./pages/Logs";
import { PVCs } from "./pages/PVCs";

export const App = () => {
  return (
    <Page>
      <Page.Header>
        <Header />
      </Page.Header>
      <Page.Main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/vms" element={<VMs />} />
          <Route path="/pvcs" element={<PVCs />} />
          <Route path="/logs" element={<Logs />} />
        </Routes>
      </Page.Main>
    </Page>
  );
};
