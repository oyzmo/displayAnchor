Display Anchor
==============

Version @VERSION@ -- https://oyzmo.no/apps/

Keeps your desktop on the display you chose, instead of letting GNOME move it
to the TV whenever the TV is switched on.


Requirements
------------

GNOME Shell 50 ONLY.

That is not caution -- older versions are untested, and an extension that
declares a GNOME version it has not run on is a good way to break someone's
session. Check yours with:

    gnome-shell --version

The extension is developed on Fedora with Wayland and an AMD card, with a
DisplayPort monitor and an HDMI TV. It talks to Mutter, so nothing in it is
specific to that hardware, but that is the setup it has actually been proven on.


Updates: there are none, automatically
--------------------------------------

This copy was downloaded from a website, not from extensions.gnome.org, so
GNOME will never offer to update it. Nothing phones home and nothing checks for
a new release. To upgrade, come back to https://oyzmo.no/apps/, download the
zip again, and run ./install.sh -- it overwrites the installed copy in place and
your settings are kept.

If you would rather have automatic updates, install it from
extensions.gnome.org instead. It is the same extension.


Installing
----------

    ./install.sh

That script does exactly three things, and you can read all of it in about a
minute:

  1. copies display-anchor@oyzmo.no/ into
     ~/.local/share/gnome-shell/extensions/
  2. runs glib-compile-schemas on that directory's schemas/ folder, which turns
     the settings definition into the binary form GNOME reads
  3. prints the two commands below

It does not ask for root, touches nothing outside that one directory, downloads
nothing, and changes no settings of yours. Please do read it first -- running a
shell script off the internet on someone's say-so is a bad habit, and this one
is short on purpose.

Then, because GNOME Shell only loads new extension code in a fresh session:

  1. log out and back in
  2. gnome-extensions enable display-anchor@oyzmo.no
  3. gnome-extensions prefs  display-anchor@oyzmo.no

Prefer to do it by hand? The whole install is one copy and one command:

    cp -r display-anchor@oyzmo.no \
          ~/.local/share/gnome-shell/extensions/
    glib-compile-schemas \
          ~/.local/share/gnome-shell/extensions/display-anchor@oyzmo.no/schemas/


First run
---------

Open the preferences (step 3 above) and set which display is your work display
and which is the TV. Then switch between them with the "TV Mode" tile in Quick
Settings, or with a keyboard shortcut you can set in the same window.

Optionally it can move the sound with the display -- off by default; turn it on
in the preferences if you want the TV's speakers to follow the picture.


Removing it
-----------

    ./uninstall.sh            keeps your settings
    ./uninstall.sh --purge    erases them too


Upgrading from version 0.2.x
----------------------------

Up to 0.2.4 this extension was called Screen Fix, and it installed itself as
gnome-screen-fix@oyzmo.no. Version 0.3.0 renames the identifier to match the
name, which means the new copy installs BESIDE the old one instead of over it.
If you leave both enabled they will both try to enforce a display layout.

So remove the old one. To keep your settings, copy them across first:

    dconf dump /org/gnome/shell/extensions/gnome-screen-fix/ \
        | dconf load /org/gnome/shell/extensions/display-anchor/

    gnome-extensions disable gnome-screen-fix@oyzmo.no
    rm -rf ~/.local/share/gnome-shell/extensions/gnome-screen-fix@oyzmo.no
    dconf reset -f /org/gnome/shell/extensions/gnome-screen-fix/

If 0.3.0 is your first version, there is nothing to do here.


Licence
-------

GPL-2.0-or-later. The full text is in display-anchor@oyzmo.no/LICENSE.
The source is the extension itself -- the files you just downloaded are the
whole thing, unminified.
