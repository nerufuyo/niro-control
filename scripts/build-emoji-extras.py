#!/usr/bin/env python3
"""Adds two groups to the emoji picker's database (shell/emoji/data/emojis.db): "Kaomoji" (text faces such as ¯\\_(ツ)_/¯) and "Text Symbols"
(arrows, maths, Greek, currency, box drawing, shapes, accents and more). Run it again after editing this file: the two groups are replaced, the emoji are
not touched. The search finds an entry by its keywords, here in English and Indonesian; for symbols the Unicode name is a keyword too."""
import sqlite3, unicodedata
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / 'shell/emoji/data/emojis.db'

# ---- Kaomoji: (text, "keywords")
KAOMOJI = [
    ("¯\\_(ツ)_/¯", "shrug whatever idk dunno entahlah bodo amat acuh"),
    ("(╯°□°)╯︵ ┻━┻", "table flip angry rage marah banting meja"),
    ("┬─┬ ノ( ゜-゜ノ)", "put table back calm tenang letakkan meja"),
    ("(ノಠ益ಠ)ノ彡┻━┻", "table flip furious rage ngamuk marah"),
    ("(•‿•)", "happy smile senang senyum"),
    ("(◕‿◕)", "happy cute smile imut senyum"),
    ("(^_^)", "happy smile senang"),
    ("(^▽^)", "happy joy gembira senang"),
    ("(＾◡＾)", "happy smile senyum"),
    ("(´▽`)", "happy relaxed santai senang"),
    ("(*^‿^*)", "happy blush malu senyum"),
    ("(≧◡≦)", "happy joy gembira"),
    ("(´∀｀)", "happy content puas senang"),
    ("٩(◕‿◕)۶", "happy cheer hore semangat"),
    ("\\(^o^)/", "hooray cheer banzai hore"),
    ("ヽ(´▽`)/", "hooray cheer hore"),
    ("＼(≧▽≦)／", "excited hooray girang heboh"),
    ("(๑˃̵ᴗ˂̵)و", "determined fight semangat"),
    ("ᕕ( ᐛ )ᕗ", "walking happy jalan"),
    ("(•̀ᴗ•́)و", "determined fight gambatte semangat"),
    ("(ง •̀_•́)ง", "fight ready siap lawan"),
    ("(ง'̀-'́)ง", "fight ready siap lawan"),
    ("(✿◠‿◠)", "flower happy bunga senang"),
    ("(◠‿◠✿)", "flower happy bunga senang"),
    ("(｡♥‿♥｡)", "love heart eyes cinta suka"),
    ("(♥ω♥)", "love heart cinta"),
    ("(´,,•ω•,,)♡", "love cute cinta imut"),
    ("(っ˘ω˘ς)", "sleepy tired ngantuk"),
    ("(˘▾˘)~♪", "music happy singing nyanyi musik"),
    ("♪(´▽｀)", "music sing nyanyi"),
    ("(´• ω •`)", "cute shy malu imut"),
    ("(´・ω・`)", "sad sigh sedih"),
    ("(；ω；)", "cry sad nangis sedih"),
    ("(T_T)", "cry sad nangis"),
    ("(;_;)", "cry sad nangis"),
    ("(ಥ_ಥ)", "cry sad nangis sedih"),
    ("(╥﹏╥)", "cry sad nangis"),
    ("(｡•́︿•̀｡)", "sad sedih"),
    ("(︶︹︺)", "sad sedih"),
    ("(´；ω；`)", "cry nangis"),
    ("ಥ‿ಥ", "touched cry happy terharu"),
    ("(ToT)", "cry nangis"),
    ("(´-ω-`)", "tired capek"),
    ("(－_－) zzz", "sleep tidur zzz ngantuk"),
    ("(－.－)...zzz", "sleep tidur"),
    ("(-_-)", "annoyed bored bosan sebal"),
    ("(¬_¬)", "side eye suspicious curiga"),
    ("(¬‿¬)", "smirk sly licik"),
    ("(￢_￢)", "suspicious curiga"),
    ("(¬､¬)", "side eye curiga"),
    ("ಠ_ಠ", "disapproval stare look of disapproval tidak setuju"),
    ("ಠ‿ಠ", "smug pleased puas"),
    ("(ಠ_ಠ)", "disapproval tidak setuju"),
    ("(；一_一)", "annoyed sebal"),
    ("(－‸ლ)", "facepalm tepuk dahi"),
    ("(ーー;)", "sweat nervous gugup keringat"),
    ("(^_^;)", "nervous sweat awkward gugup canggung"),
    ("(´Д`;)", "shock nervous kaget"),
    ("(°ロ°)", "shock surprised kaget"),
    ("Σ(°ロ°)", "shock kaget"),
    ("(°o°)", "surprised kaget"),
    ("(☉_☉)", "stare shocked melotot"),
    ("(⊙_⊙)", "wide eyes surprised kaget melotot"),
    ("(◎_◎)", "dizzy confused bingung pusing"),
    ("(@_@)", "dizzy pusing"),
    ("(x_x)", "dead mati"),
    ("(✖╭╮✖)", "dead mati"),
    ("(╬ಠ益ಠ)", "angry rage marah"),
    ("(ノ`Д´)ノ", "angry marah"),
    ("(`Д´)", "angry marah"),
    ("(#`Д´)", "angry marah"),
    ("(҂`з´)", "angry marah"),
    ("ヽ(｀Д´)ﾉ", "angry marah"),
    ("(ʘ‿ʘ)", "wide eyes cute imut"),
    ("(ʘᗩʘ')", "shock kaget"),
    ("( ͡° ͜ʖ ͡°)", "lenny face smirk meme"),
    ("( ͡~ ͜ʖ ͡°)", "lenny wink meme"),
    ("( ͠° ͟ʖ ͡°)", "lenny meme"),
    ("(☞ﾟヮﾟ)☞", "point you finger gun tunjuk"),
    ("☜(ﾟヮﾟ☜)", "point finger tunjuk"),
    ("(☞ ͡° ͜ʖ ͡°)☞", "point lenny tunjuk"),
    ("¯\\(°_o)/¯", "shrug confused bingung"),
    ("ʕ•ᴥ•ʔ", "bear beruang cute imut"),
    ("ʕ•́ᴥ•̀ʔっ♡", "bear love beruang cinta"),
    ("ʕ ᵔᴥᵔ ʔ", "bear beruang"),
    ("(=^･ω･^=)", "cat kucing"),
    ("(=^‥^=)", "cat kucing"),
    ("(=｀ω´=)", "cat kucing"),
    ("ฅ^•ﻌ•^ฅ", "cat kucing meong"),
    ("ᓚᘏᗢ", "cat kucing"),
    ("/ᐠ｡ꞈ｡ᐟ\\", "cat kucing"),
    ("(◕ᴥ◕ʋ)", "dog anjing"),
    ("U・ᴥ・U", "dog anjing"),
    ("∪･ω･∪", "dog anjing"),
    ("(◕‿◕)♡", "love cinta"),
    ("(´ε｀ )♡", "kiss love cium cinta"),
    ("(´∩｡• ᵕ •｡∩`)", "shy malu"),
    ("(っ´ω`)ﾉ(╥ω╥)", "comfort hug peluk hibur"),
    ("(づ｡◕‿‿◕｡)づ", "hug peluk"),
    ("(づ￣ ³￣)づ", "kiss hug cium peluk"),
    ("(つ≧▽≦)つ", "hug peluk"),
    ("(っ・ω・)っ", "hug peluk"),
    ("(⊃｡•́‿•̀｡)⊃", "hug peluk"),
    ("(＾• ω •＾)", "cat kucing happy"),
    ("(¬‿¬ )", "sly licik"),
    ("(҂⌣̀_⌣́)", "determined serius"),
    ("(•_•)", "serious deadpan datar"),
    ("(•_•) ( •_•)>⌐■-■ (⌐■_■)", "deal with it sunglasses kacamata keren"),
    ("(⌐■_■)", "cool sunglasses keren kacamata"),
    ("( •_•)>⌐■-■", "deal with it sunglasses keren"),
    ("(▀̿Ĺ̯▀̿ ̿)", "cool gangster keren"),
    ("[̲̅$̲̅(̲̅ ͡° ͜ʖ ͡°̲̅)̲̅$̲̅]", "money rich uang kaya"),
    ("(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧", "sparkles magic bintang ajaib"),
    ("(ﾉ´ヮ`)ﾉ*: ･ﾟ", "sparkles throw lempar"),
    ("✧･ﾟ: *✧･ﾟ:*", "sparkles bintang"),
    ("(੭•̀ω•́)੭", "fight gambatte semangat"),
    ("(ง ͠° ͟ل͜ ͡°)ง", "fight lawan"),
    ("o(≧▽≦)o", "happy excited senang"),
    ("(•ө•)♡", "love cinta"),
    ("(ɔ˘з˘)♥", "kiss love cium"),
    ("( ˘ ³˘)♥", "kiss cium"),
    ("(´ω｀*)", "shy malu"),
    ("(๑•́ ₃ •̀๑)", "pout cemberut"),
    ("(๑•̀ㅂ•́)و✧", "determined semangat"),
    ("(•̀o•́)ง", "determined fight"),
    ("(; ･`д･´)", "determined serious serius"),
    ("(´-﹏-`；)", "worried khawatir"),
    ("(；′⌒`)", "worried sad khawatir"),
    ("orz", "bow despair sujud putus asa"),
    ("m(_ _)m", "bow thanks sorry maaf terima kasih"),
    ("(_ _)", "bow maaf"),
    ("(*_ _)", "bow maaf"),
    ("m(__)m", "bow maaf terima kasih"),
    ("(^人^)", "please pray mohon minta tolong"),
    ("(人_人)", "pray doa"),
    ("🙏(˘˘)", "pray doa"),
    ("(´人`)", "please tolong"),
    ("(◡‿◡✿)", "flower happy bunga"),
    ("(✿╹◡╹)", "flower bunga"),
    ("(❁´◡`❁)", "flower happy bunga"),
    ("(◍•ᴗ•◍)", "happy senang"),
    ("(●´ω｀●)", "happy bashful malu"),
    ("(｡◕‿◕｡)", "cute imut"),
    ("(ᵔᴥᵔ)", "cute imut"),
    ("(ㆆ _ ㆆ)", "stare melotot"),
    ("(´ ▽ ` ).｡ｏ♡", "dreaming love melamun cinta"),
    ("(๑¯ω¯๑)", "relax santai"),
    ("(￣ー￣)", "smug puas"),
    ("(￣ω￣)", "smile content tenang"),
    ("(￣▽￣)", "happy smile"),
    ("(￣～￣;)", "awkward canggung"),
    ("(￣□￣;)", "shock kaget"),
    ("(ノ°益°)ノ", "angry marah"),
    ("(ノ°ο°)ノ", "surprise kaget"),
    ("(ﾉ≧∀≦)ﾉ", "happy wave senang"),
    ("(^_−)☆", "wink kedip"),
    ("(^_~)", "wink kedip"),
    ("(~_^)", "wink kedip"),
    (";)", "wink kedip"),
    (":-)", "smile senyum"),
    (":-(", "sad sedih"),
    (":-D", "grin big smile ketawa"),
    (":-P", "tongue lidah"),
    (":-O", "surprised kaget"),
    (":'(", "cry nangis"),
    (":3", "cat face cute imut"),
    ("<3", "heart hati cinta"),
    ("</3", "broken heart patah hati"),
    ("XD", "laugh ketawa"),
    ("^_^", "happy smile senang"),
    ("-_-", "bored bosan"),
    ("o_O", "confused bingung"),
    ("O_o", "confused bingung"),
    ("T_T", "cry nangis"),
    ("UwU", "cute imut"),
    ("OwO", "cute imut"),
    (">_<", "frustrated pain kesal sakit"),
    ("(>_<)", "frustrated sakit kesal"),
    ("(>人<)", "begging please mohon"),
]

# ---- Text symbols: (characters, "tag words", sub-group keyword)
SYMBOL_SETS = [
    ("←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓⇔⇕➔➜➡⬅⬆⬇⬈⬉⬊⬋↩↪↰↱↲↳↶↷⟲⟳↺↻⇄⇅⇆⇦⇧⇨⇩➤➥➦➧➨➚➘➙➛➝➞⟵⟶⟷⇝⇜↦↤↥↧⤴⤵↯↬↭", "arrow panah", "arrows"),
    ("±×÷≠≈≡≤≥∞√∛∜∑∏∫∬∭∮∂∆∇∈∉∋⊂⊃⊆⊇∪∩∧∨¬∀∃∄∴∵∝∅∠∥⊥°′″‰‱µ⌈⌉⌊⌋⟨⟩⌀∘∙⋅⊕⊗⊖⊙≅≃≪≫≺≻⊢⊨ℕℤℚℝℂℙℵℏℓ№∓∕∖∗∟∡∢∣∤∦∷∼∽≁≂≄≆≇≉≊≋≌≍≎≏≐≑≒≓≔≕≖≗≘≙≚≛≜≝≞≟≢≣≦≧≨≩≬≭≮≯≰≱≲≳≴≵≶≷≸≹≼≽≾≿⊄⊅⊈⊉⊊⊋⊌⊍⊎⊏⊐⊑⊒⊓⊔⊘⊚⊛⊜⊝⊞⊟⊠⊡⊣⊤⊥⊦⊧⊩⊪⊫⊬⊭⊮⊯", "math matematika simbol", "math"),
    ("αβγδεζηθικλμνξοπρςστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ", "greek letter huruf yunani", "greek"),
    ("$¢£¤¥€₹₽₩₿₫₺₪฿₱₴₦₡₲₵₭₮₸₼₾﷼₠₢₣₤₥₧₨₯₰₳₶₷₻₽", "currency money uang mata uang", "currency"),
    ("–—―…‥•·‣◦‧⁃†‡§¶©®™℠«»‹›“”‘’„‚「」『』〈〉《》【】〔〕〖〗‼⁇⁈⁉‽⸮¡¿¦‖⁂※‛‟❝❞❛❜❮❯❬❭‰", "punctuation typography tanda baca", "punctuation"),
    ("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜ", "superscript subscript pangkat indeks", "super-sub"),
    ("½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒↉", "fraction pecahan", "fractions"),
    ("ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿ", "roman numeral angka romawi", "roman"),
    ("⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳❶❷❸❹❺❻❼❽❾❿➀➁➂➃➄➅➆➇➈➉⓵⓶⓷⓸⓹⓺⓻⓼⓽⓾ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ", "circled number letter angka bulat huruf", "circled"),
    ("─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿━┃┏┓┗┛┣┫┳┻╋┅┇┉┋╌╎╍╏", "box drawing garis kotak tabel", "box"),
    ("▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟", "block blok", "blocks"),
    ("■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◂◃◄◅◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯⬛⬜⬟⬠⬡⬢⬣⏺⏹", "shape geometric bentuk lingkaran kotak segitiga", "shapes"),
    ("★☆✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋⁎⁑✢✣✤✥", "star flower asterisk bintang bunga", "stars"),
    ("✓✔✕✖✗✘☐☑☒✙✚✛✜✝✞✟✠✡➕➖➗❌❎✂✃✄✆✇✈✉✌✍✎✏✐✑✒", "check cross dingbat centang silang", "dingbats"),
    ("♠♡♢♣♤♥♦♧❤❥❦❧☙", "heart suit card hati kartu", "hearts"),
    ("♩♪♫♬♭♮♯𝄞𝄢", "music note musik nada", "music"),
    ("☀☁☂☃☄☼☽☾☿♁♃♄♅♆♇♈♉♊♋♌♍♎♏♐♑♒♓☉☊☋☌☍", "weather planet zodiac cuaca planet zodiak", "weather"),
    ("☎☏✆⌚⌛⌨⏏⏩⏪⏫⏬⏭⏮⏯⏰⏱⏲⏳⚑⚐⚓⚔⚖⚙⚛⚜⚠⚡⚰⚱☠☢☣☮☯☸☪☭☹☺☻♀♂⚤⚥⚧", "misc symbol simbol lain", "misc"),
    ("♔♕♖♗♘♙♚♛♜♝♞♟⚀⚁⚂⚃⚄⚅", "chess dice catur dadu", "games"),
    ("⌘⌥⇧⌃⎋⏎⌫⌦⇥⇤␣⌤⎆⌅⌆⌧⎉⎈⍾⌨", "keyboard key keyboard tombol", "keys"),
    ("ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿĀāĂăĄąĆćČčĎďĐđĒēĘęĚěĞğĪīİıŁłŃńŇňŌōŐőŒœŘřŚśŞşŠšŤťŪūŮůŰűŹźŻżŽž", "latin accent letter aksen huruf", "accents"),
    ("©®™℗℃℉℅℆℡℮℠⏏℀℁℈℔℥Ω℧Å№", "unit sign satuan tanda", "signs"),
]

ID_NAMES = {
    "arrows": "panah", "math": "matematika", "greek": "yunani", "currency": "uang", "punctuation": "tanda baca",
}

def symbol_rows():
    seen = set()
    for chars, words, sub in SYMBOL_SETS:
        for ch in chars:
            if ch in seen or ch.isspace():
                continue
            seen.add(ch)
            try:
                name = unicodedata.name(ch).lower()
            except ValueError:
                name = ""
            yield ch, f"{name} {words} {sub}".strip()

def main():
    con = sqlite3.connect(DB)
    con.execute("DELETE FROM emojis WHERE emoji_group IN ('Kaomoji', 'Text Symbols')")
    have = {r[0] for r in con.execute("SELECT unicode FROM emojis")}
    added = {'Kaomoji': 0, 'Text Symbols': 0}
    for text, words in KAOMOJI:
        if text in have:
            continue
        con.execute("INSERT INTO emojis(unicode, description, skin_tone, emoji_group, clicked_times) VALUES (?, ?, '', 'Kaomoji', 0)",
                    (text, f"{words} kaomoji emoticon wajah"))
        have.add(text); added['Kaomoji'] += 1
    for ch, words in symbol_rows():
        if ch in have:
            continue
        con.execute("INSERT INTO emojis(unicode, description, skin_tone, emoji_group, clicked_times) VALUES (?, ?, '', 'Text Symbols', 0)",
                    (ch, f"{words} simbol symbol"))
        have.add(ch); added['Text Symbols'] += 1
    con.commit()
    con.execute("VACUUM")
    con.close()
    print(added)

if __name__ == '__main__':
    main()
