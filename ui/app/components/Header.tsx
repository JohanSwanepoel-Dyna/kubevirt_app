import React from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components-preview/layouts";

export const Header = () => {
  return (
    <AppHeader>
      <AppHeader.NavItems>
        <AppHeader.AppNavLink as={Link} to="/" />
        <AppHeader.NavItem as={Link} to="/">
          Overview
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/vms">
          Virtual Machines
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/pvcs">
          Storage
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/logs">
          Logs
        </AppHeader.NavItem>
      </AppHeader.NavItems>
    </AppHeader>
  );
};
