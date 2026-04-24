UUID = dj-mouse-warp@djmsqrvve
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES = extension.js metadata.json prefs.js schemas

.PHONY: install uninstall package compile-schemas test

compile-schemas:
	glib-compile-schemas schemas/

install: compile-schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(SOURCES) $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Enable with: gnome-extensions enable $(UUID)"
	@echo "Then log out and back in (Wayland requires re-login)."

uninstall:
	rm -rf $(INSTALL_DIR)
	@echo "Removed $(INSTALL_DIR)"

test:
	bash tests/run_tests.sh

package: compile-schemas
	zip -r $(UUID).zip $(SOURCES)
	@echo "Packaged as $(UUID).zip — upload to extensions.gnome.org"
