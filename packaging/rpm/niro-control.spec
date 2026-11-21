# Niro Control for Fedora: built from the same tree as the .deb, by packaging/build-rpm.sh.
# The binaries and extensions are compiled before rpmbuild runs (npm and cargo need the network),
# so this spec only installs what the build script staged in the stage directory.
%global debug_package %{nil}
%global __strip /bin/true

Name:           niro-control
Version:        @VERSION@
Release:        @RELEASE@%{?dist}
Summary:        The look of the GNOME desktop in one place
License:        GPL-3.0-or-later
URL:            https://github.com/nerufuyo/niro-control
ExclusiveArch:  x86_64 aarch64

Requires:       gnome-shell >= 46
Requires:       dconf
Requires:       gtk4
Requires:       libadwaita
Requires:       gjs
Requires:       fontconfig
Requires:       vulkan-loader
Requires:       glib2
Requires:       gnome-shell-extension-appindicator
Requires:       gnome-shell-extension-user-theme
Recommends:     tesseract
Recommends:     tesseract-langpack-ind
Requires:       polkit
BuildRequires:  systemd-rpm-macros

%description
Island (a notch on the top bar), a macOS-style dock, an application search, window blur,
rounded corners, and one control panel (org.niro.control: tone, opacity, blur) that sets them all.

%prep

%build

%install
cp -a %{_stagedir}/. %{buildroot}/

%post
glib-compile-schemas %{_datadir}/glib-2.0/schemas >/dev/null 2>&1 || :
fc-cache %{_datadir}/fonts/island >/dev/null 2>&1 || :
dconf update >/dev/null 2>&1 || :
gtk-update-icon-cache -q -t -f %{_datadir}/icons/hicolor >/dev/null 2>&1 || :
systemctl --global enable island-daemon.service >/dev/null 2>&1 || :
# The daily update timer is installed but stays off until the user switches it on (Settings → About).
%systemd_post niro-control-update.timer

%preun
%systemd_preun niro-control-update.timer

%postun
%systemd_postun niro-control-update.timer
glib-compile-schemas %{_datadir}/glib-2.0/schemas >/dev/null 2>&1 || :
gtk-update-icon-cache -q -t -f %{_datadir}/icons/hicolor >/dev/null 2>&1 || :
if [ $1 -eq 0 ]; then
  systemctl --global disable island-daemon.service >/dev/null 2>&1 || :
  dconf update >/dev/null 2>&1 || :
fi

%files
%{_bindir}/*
%{_datadir}/gnome-shell/extensions/*@niro.local
%{_datadir}/niro-control
%{_datadir}/applications/org.niro.Control.desktop
%{_datadir}/applications/org.niro.Snip.desktop
%{_datadir}/icons/hicolor/scalable/apps/org.niro.Control.svg
%{_datadir}/icons/hicolor/symbolic/apps/org.niro.Control-symbolic.svg
%{_datadir}/glib-2.0/schemas/org.niro.control.gschema.xml
%{_datadir}/dbus-1/services/org.niro.island.*.service
%{_datadir}/fonts/island
%{_datadir}/doc/niro-control
%{_prefix}/lib/systemd/user/island-daemon.service
%{_prefix}/lib/systemd/system/niro-control-update.service
%{_prefix}/lib/systemd/system/niro-control-update.timer
%{_prefix}/libexec/niro-control
%{_datadir}/polkit-1/actions/org.niro.control.auto-update.policy
%config(noreplace) %{_sysconfdir}/dconf/db/local.d/00-niro

%changelog
* Sun Nov 15 2026 nerufuyo <local@localhost> - 1.0.0-1
- Fedora package: same tree as the .deb, GNOME Shell 46 to 51
