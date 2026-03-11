UUID = mouse-warp@djmsqrvve
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES = extension.js metadata.json

.PHONY: install uninstall package

install:
	mkdir -p $(INSTALL_DIR)
	cp $(SOURCES) $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Enable with: gnome-extensions enable $(UUID)"
	@echo "Then log out and back in (Wayland requires re-login)."

uninstall:
	rm -rf $(INSTALL_DIR)
	@echo "Removed $(INSTALL_DIR)"

package:
	zip -j $(UUID).zip $(SOURCES)
	@echo "Packaged as $(UUID).zip — upload to extensions.gnome.org"
