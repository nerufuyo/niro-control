// A minimal MPRIS media player for the capture session: NIRO's island shows whatever the session's player announces. Not a product.
// Usage: gjs -m fake-player.js /path/to/album.png
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const art = `file://${ARGV[0]}`;
const ROOT = `<node><interface name="org.mpris.MediaPlayer2"><method name="Raise"/><method name="Quit"/>
<property name="CanQuit" type="b" access="read"/><property name="CanRaise" type="b" access="read"/><property name="HasTrackList" type="b" access="read"/>
<property name="Identity" type="s" access="read"/><property name="DesktopEntry" type="s" access="read"/></interface></node>`;
const PLAYER = `<node><interface name="org.mpris.MediaPlayer2.Player"><method name="Next"/><method name="Previous"/><method name="Pause"/><method name="PlayPause"/><method name="Stop"/><method name="Play"/>
<method name="Seek"><arg type="x" direction="in"/></method><method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
<property name="PlaybackStatus" type="s" access="read"/><property name="Metadata" type="a{sv}" access="read"/><property name="Position" type="x" access="read"/>
<property name="Rate" type="d" access="read"/><property name="Volume" type="d" access="readwrite"/><property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/>
<property name="CanPlay" type="b" access="read"/><property name="CanPause" type="b" access="read"/><property name="CanSeek" type="b" access="read"/><property name="CanControl" type="b" access="read"/></interface></node>`;
let status = 'Paused', position = 74 * 1e6;           // 1:14 into the track
const meta = () => new GLib.Variant('a{sv}', {
    'mpris:trackid': GLib.Variant.new_object_path('/org/niro/demo/track1'), 'mpris:length': GLib.Variant.new_int64(213 * 1e6), 'mpris:artUrl': GLib.Variant.new_string(art),
    'xesam:title': GLib.Variant.new_string('Glass Hours'), 'xesam:artist': GLib.Variant.new_strv(['Nightfall Collective']), 'xesam:album': GLib.Variant.new_string('Midnight Signal'),
});
let player, root;
const rootImpl = {Raise() {}, Quit() {}, CanQuit: false, CanRaise: false, HasTrackList: false, Identity: 'Niro demo player', DesktopEntry: 'niro-demo'};
const set = s => { status = s; player.emit_property_changed('PlaybackStatus', new GLib.Variant('s', status)); };
const playerImpl = {
    Next() {}, Previous() {}, Stop() { set('Stopped'); }, Pause() { set('Paused'); }, PlayPause() { set(status === 'Playing' ? 'Paused' : 'Playing'); }, Play() { set('Playing'); },
    Seek() {}, SetPosition() {},
    get PlaybackStatus() { return status; }, get Metadata() { return meta(); }, get Position() { return position; }, Rate: 1.0, Volume: 0.8,
    CanGoNext: true, CanGoPrevious: true, CanPlay: true, CanPause: true, CanSeek: true, CanControl: true,
};
Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.niro_demo', Gio.BusNameOwnerFlags.NONE, conn => {
    root = Gio.DBusExportedObject.wrapJSObject(ROOT, rootImpl); root.export(conn, '/org/mpris/MediaPlayer2');
    player = Gio.DBusExportedObject.wrapJSObject(PLAYER, playerImpl); player.export(conn, '/org/mpris/MediaPlayer2');
}, null, null);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { if (status === 'Playing') position += 5e5; return true; });
GLib.MainLoop.new(null, false).run();
