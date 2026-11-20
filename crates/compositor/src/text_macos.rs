//! Rastérisation du texte des annotations sur macOS — CoreText + CoreGraphics.
//!
//! Équivalent macOS de `text_windows.rs` (DirectWrite + Direct2D sur surface DXGI).
//! Le module exporte la même surface publique (`TextSpec`, `TextRasterizer`) pour que
//! `compositor.rs` puisse appeler `TextRasterizer::new()` / `rasterize(...)` sans
//! connaître la plateforme.
//!
//! # Pipeline
//!
//! Tout passe par les API **C** de CoreText/CoreGraphics, pas par `msg_send!` :
//! `CTFont`, `CTFramesetter`, `CTFrame`, `CGColor` et `CGContext` sont des CFTypes, pas
//! des classes Objective-C. (La première version de ce fichier envoyait
//! `deviceRGBColorSpace` à une classe `CGColorSpace` et `stringWithCString:encoding:` à
//! une classe `CFString` ; aucune des deux n'existe dans le runtime ObjC, donc
//! `AnyClass::get` rendait `None` et chaque attribut était silencieusement sauté. Les
//! clés d'attribut étaient elles aussi fabriquées : `Sel::register("NSColor")` produit un
//! sélecteur, là où `CFAttributedString` attend la CFString `kCTForegroundColorAttributeName`.)
//!
//! 1. `CGBitmapContextCreate` sur un buffer CPU, BGRA prémultiplié
//!    (`kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little`) — l'ordre d'octets
//!    que `MTLPixelFormat::BGRA8Unorm` attend.
//! 2. `CFAttributedString` avec police (`kCTFontAttributeName`), couleur
//!    (`kCTForegroundColorAttributeName`), soulignement (`kCTUnderlineStyleAttributeName`)
//!    et alignement (`kCTParagraphStyleAttributeName`).
//! 3. `CTFramesetterSuggestFrameSizeWithConstraints` mesure le bloc mis en page, puis
//!    `block_layout` en déduit le cadre (centré verticalement) et la plaque de fond
//!    (`spec.background`, alpha 0 = transparent) qui l'habille.
//! 4. `CTFramesetterCreateFrame` sur ce cadre, puis `CTFrameDraw`.
//! 5. `MTLTexture` BGRA8Unorm + `replace_region` depuis le buffer CPU.
//!
//! `TextSpec::cache_key()` est byte-identique à la version Windows — la policy de cache
//! est partagée.

use crate::d3d::Gpu;
use crate::text_fx::{self, FillSpec, Paint, TextFx, ENTER_MS, POP_WINDOW_MS, SLIDE_MS};
use anyhow::{anyhow, bail, Result};
use std::ffi::c_void;
use std::path::PathBuf;

/// Spécification d'un texte à rastériser. Mêmes champs que `text_windows::TextSpec`
/// — le moteur macOS les consomme via `cache_key` pour déterminer si une re-rastérisation
/// est nécessaire.
#[derive(Clone, PartialEq)]
pub struct TextSpec {
    pub content: String,
    /// RGBA 0..1 (déjà parsé depuis la chaîne CSS côté appelant).
    pub color: [f32; 4],
    /// RGBA 0..1 ; alpha 0 = pas de fond (le CSS `transparent`).
    pub background: [f32; 4],
    pub font_size_px: f32,
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// "left" | "center" | "right".
    pub align: String,
    /// "top" | "center" | "bottom" — quelle arête du bloc est épinglée à la boîte.
    /// "center" est le comportement historique (et celui des annotations) ; les
    /// sous-titres passent "bottom" ou "top" pour que l'arête ancrée ne bouge pas
    /// quand le texte gagne une ligne.
    pub valign: String,
    /// Taille de la boîte en px de sortie — la mise en page en dépend (retours à la ligne).
    pub box_px: [u32; 2],
    /// Ce qu'une partie du texte fait autrement : le mot qui s'allume, le mot d'accent.
    pub runs: Vec<TextRunSpec>,
    /// Le contour : couleur, épaisseur en fraction de la police.
    pub stroke: Option<([f32; 4], f32)>,
    /// L'ombre : couleur, flou et décalage vers le bas en fraction de la police.
    pub shadow: Option<([f32; 4], f32, f32)>,
    /// Lumière, dégradés, plasma : cf. `text_fx`.
    pub fx: Option<TextFx>,
    /// Depuis le début de ce texte, plafonné dès que plus rien n'en dépend (`set_time`).
    pub elapsed_ms: f32,
    /// L'heure de la scène pour ce qui coule en continu d'un sous-titre au suivant. 0 sinon.
    pub scene_ms: f32,
}

/// Une partie du texte, en unités UTF-16.
#[derive(Debug, Clone, PartialEq)]
pub struct TextRunSpec {
    pub start: usize,
    pub len: usize,
    pub color: Option<[f32; 4]>,
    pub pill: Option<[f32; 4]>,
    pub font_family: Option<String>,
    pub size_mul: f32,
    pub italic: bool,
    pub glow: Option<[f32; 4]>,
    pub fill: Option<FillSpec>,
    pub pop_peak: f32,
    pub pop_hold: f32,
    pub hide: bool,
    pub pill_from: Option<(usize, usize)>,
}

fn is_emoji(c: char) -> bool {
    matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE0F | 0x20E3)
}

impl TextRunSpec {
    fn pops(&self) -> bool {
        self.pop_peak != 1.0 || self.pop_hold != 1.0
    }
}

impl TextSpec {
    /// Le chemin à passes de `text_fx`, seulement pour ce qui le demande : un texte uni garde au
    /// pixel près le rendu de toujours.
    fn wants_fx(&self) -> bool {
        // shortcut: a colour glyph ignores the colours the masks rely on and would land in every
        // pass, so text with an emoji in it draws plain. Draw emoji apart if titles need both.
        if self.content.chars().any(is_emoji) {
            return false;
        }
        self.fx.is_some()
            || self
                .runs
                .iter()
                .any(|run| run.pops() || run.hide || run.fill.is_some() || run.pill_from.is_some())
    }

    /// La marge autour de la boîte : la lumière et un mot qui grandit dépassent des lettres, et ils
    /// ne doivent pas s'arrêter net sur le bord de la texture. Trois passes de boîte atteignent
    /// 1,74 fois le rayon. Rien pour un texte uni.
    pub fn margin_px(&self) -> u32 {
        if !self.wants_fx() {
            return 0;
        }
        let reach = self.fx.as_ref().and_then(|fx| fx.glow.as_ref()).map_or(0.0, |glow| glow.em);
        let reach = reach.max(if self.fx.as_ref().is_some_and(|fx| fx.enter.is_some()) { 0.5 } else { 0.0 });
        // Un mot au bord de la colonne dépasse de la moitié de ce qu'il gagne.
        let grows = self.runs.iter().map(|run| run.pop_peak.max(run.pop_hold)).fold(1.0, f32::max) - 1.0;
        let reach_px = self.font_size_px * (reach * 1.8).max(0.4) + grows * self.box_px[0] as f32 * 0.5;
        reach_px.ceil().min(480.0) as u32
    }

    /// Le temps de cette image, réduit à ce dont les pixels dépendent vraiment.
    pub fn set_time(&mut self, elapsed_ms: f32, scene_ms: f32) {
        let mut window: f32 = 0.0;
        if self.runs.iter().any(|run| run.pops()) {
            window = window.max(POP_WINDOW_MS);
        }
        if self.runs.iter().any(|run| run.pill_from.is_some()) {
            window = window.max(SLIDE_MS);
        }
        if self.fx.as_ref().is_some_and(|fx| fx.enter.is_some()) {
            window = window.max(ENTER_MS);
        }
        self.elapsed_ms = elapsed_ms.clamp(0.0, window).round();
        let moves = self.fx.as_ref().is_some_and(|fx| fx.moves())
            || self.runs.iter().any(|run| {
                run.fill.as_ref().is_some_and(|fill| fill.kind == "plasma" || fill.flow != 0.0)
            });
        self.scene_ms = if moves { scene_ms.round() } else { 0.0 };
    }

    /// Tout ce qui décide des pixels sauf le temps.
    fn still_key(&self) -> u64 {
        let mut still = self.clone();
        still.elapsed_ms = 0.0;
        still.scene_ms = 0.0;
        still.cache_key()
    }

    /// Clé de cache : couvre exactement les champs dont la variation provoque un
    /// changement de pixels. Identique côté Windows/macOS (la policy est partagée).
    pub fn cache_key(&self) -> u64 {
        // FNV-1a sur les mêmes octets, dans le même ordre, que
        // `text_windows::TextSpec::cache_key`. La version précédente appelait
        // `Hash::hash(&mut h)` avec un `u64` en guise de `Hasher` — ça ne compile pas,
        // et même corrigé, `DefaultHasher` ne donne pas la même clé que Windows.
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |bytes: &[u8]| {
            for b in bytes {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100_0000_01b3);
            }
        };
        mix(self.content.as_bytes());
        mix(self.font_family.as_bytes());
        mix(&self.font_size_px.to_bits().to_le_bytes());
        for c in self.color.iter().chain(self.background.iter()) {
            mix(&c.to_bits().to_le_bytes());
        }
        mix(&[self.bold as u8, self.italic as u8, self.underline as u8]);
        mix(self.align.as_bytes());
        // Juste après `align`, mêmes octets et même position que sur les deux
        // autres backends : deux specs ne différant que par l'alignement vertical
        // rendraient sinon les pixels l'une de l'autre depuis le cache.
        mix(self.valign.as_bytes());
        mix(&self.box_px[0].to_le_bytes());
        mix(&self.box_px[1].to_le_bytes());
        // Ici seulement : les deux autres backends n'ont pas ces champs.
        mix(format!(
            "{:?}{:?}{:?}{:?}{}{}",
            self.runs, self.stroke, self.shadow, self.fx, self.elapsed_ms, self.scene_ms
        )
        .as_bytes());
        h
    }
}

// ---------------------------------------------------------------------------
// FFI CoreFoundation / CoreGraphics / CoreText
// ---------------------------------------------------------------------------

type CFTypeRef = *const c_void;
type CFIndex = isize;
type CGFloat = f64;

#[repr(C)]
#[derive(Clone, Copy)]
struct CFRange {
    location: CFIndex,
    length: CFIndex,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: CGFloat,
    y: CGFloat,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: CGFloat,
    height: CGFloat,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// `kCGImageAlphaPremultipliedFirst` (=2) | `kCGBitmapByteOrder32Little` (=2 << 12).
/// Ensemble : ARGB prémultiplié en mémoire little-endian, soit l'ordre d'octets B,G,R,A —
/// exactement `MTLPixelFormat::BGRA8Unorm`.
const CG_BITMAP_INFO_BGRA_PREMUL: u32 = 2 | (2 << 12);
/// `kCGImageAlphaOnly` : un octet de couverture par pixel, le masque des passes de `text_fx`.
const CG_IMAGE_ALPHA_ONLY: u32 = 7;
/// `kCFStringEncodingUTF8`.
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// `kCFNumberSInt32Type`.
const K_CF_NUMBER_S_INT32_TYPE: CFIndex = 3;
/// `kCFNumberFloat64Type`.
const K_CF_NUMBER_FLOAT64_TYPE: CFIndex = 6;
/// `kCGLineJoinRound` : un contour épais sans pointes aux angles des lettres.
const K_CG_LINE_JOIN_ROUND: i32 = 1;
/// `kCTParagraphStyleSpecifierAlignment`.
const K_CT_PARAGRAPH_STYLE_SPECIFIER_ALIGNMENT: u32 = 0;
/// `kCTParagraphStyleSpecifierLineHeightMultiple`.
const K_CT_PARAGRAPH_STYLE_SPECIFIER_LINE_HEIGHT_MULTIPLE: u32 = 7;
/// `CTFontSymbolicTraits` : italique / gras.
const K_CT_FONT_TRAIT_ITALIC: u32 = 1 << 0;
const K_CT_FONT_TRAIT_BOLD: u32 = 1 << 1;

#[repr(C)]
#[derive(Clone, Copy)]
struct CTParagraphStyleSetting {
    spec: u32,
    value_size: usize,
    value: *const c_void,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFStringCreateWithBytes(
        alloc: CFTypeRef,
        bytes: *const u8,
        num_bytes: CFIndex,
        encoding: u32,
        is_external_representation: u8,
    ) -> CFTypeRef;
    fn CFNumberCreate(alloc: CFTypeRef, the_type: CFIndex, value_ptr: *const c_void) -> CFTypeRef;
    fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFTypeRef;
    fn CFAttributedStringCreateMutableCopy(
        alloc: CFTypeRef,
        max_length: CFIndex,
        str_: CFTypeRef,
    ) -> CFTypeRef;
    fn CFAttributedStringSetAttribute(
        str_: CFTypeRef,
        range: CFRange,
        attr_name: CFTypeRef,
        value: CFTypeRef,
    );
    fn CFAttributedStringGetLength(str_: CFTypeRef) -> CFIndex;
    fn CFAttributedStringCreate(
        alloc: CFTypeRef,
        str_: CFTypeRef,
        attributes: CFTypeRef,
    ) -> CFTypeRef;
    fn CFURLCreateFromFileSystemRepresentation(
        alloc: CFTypeRef,
        buffer: *const u8,
        buf_len: CFIndex,
        is_directory: u8,
    ) -> CFTypeRef;
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFArrayGetCount(array: CFTypeRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: CFIndex) -> CFTypeRef;
    fn CFStringGetCString(
        string: CFTypeRef,
        buffer: *mut std::ffi::c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> u8;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorSpaceCreateDeviceRGB() -> CFTypeRef;
    fn CGColorSpaceRelease(space: CFTypeRef);
    fn CGColorCreate(space: CFTypeRef, components: *const CGFloat) -> CFTypeRef;
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: CFTypeRef,
        bitmap_info: u32,
    ) -> CFTypeRef;
    fn CGContextRelease(ctx: CFTypeRef);
    fn CGContextSetRGBFillColor(ctx: CFTypeRef, r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat);
    fn CGContextAddPath(ctx: CFTypeRef, path: CFTypeRef);
    fn CGContextFillPath(ctx: CFTypeRef);
    fn CGContextSaveGState(ctx: CFTypeRef);
    fn CGContextRestoreGState(ctx: CFTypeRef);
    fn CGContextSetShadowWithColor(ctx: CFTypeRef, offset: CGSize, blur: CGFloat, color: CFTypeRef);
    fn CGContextSetLineJoin(ctx: CFTypeRef, join: i32);
    fn CGContextTranslateCTM(ctx: CFTypeRef, tx: CGFloat, ty: CGFloat);
    fn CGContextScaleCTM(ctx: CFTypeRef, sx: CGFloat, sy: CGFloat);
    fn CGPathCreateWithRect(rect: CGRect, transform: *const c_void) -> CFTypeRef;
    fn CGPathCreateWithRoundedRect(
        rect: CGRect,
        corner_width: CGFloat,
        corner_height: CGFloat,
        transform: *const c_void,
    ) -> CFTypeRef;
}

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontCreateWithName(name: CFTypeRef, size: CGFloat, matrix: *const c_void) -> CFTypeRef;
    fn CTFontCreateCopyWithSymbolicTraits(
        font: CFTypeRef,
        size: CGFloat,
        matrix: *const c_void,
        sym_trait_value: u32,
        sym_trait_mask: u32,
    ) -> CFTypeRef;
    fn CTParagraphStyleCreate(settings: *const CTParagraphStyleSetting, count: usize) -> CFTypeRef;
    fn CTFramesetterCreateWithAttributedString(attr: CFTypeRef) -> CFTypeRef;
    fn CTFramesetterSuggestFrameSizeWithConstraints(
        framesetter: CFTypeRef,
        string_range: CFRange,
        frame_attributes: CFTypeRef,
        constraints: CGSize,
        fit_range: *mut CFRange,
    ) -> CGSize;
    fn CTFramesetterCreateFrame(
        framesetter: CFTypeRef,
        string_range: CFRange,
        path: CFTypeRef,
        frame_attributes: CFTypeRef,
    ) -> CFTypeRef;
    fn CTFrameDraw(frame: CFTypeRef, context: CFTypeRef);
    fn CTFrameGetLines(frame: CFTypeRef) -> CFTypeRef;
    fn CTFrameGetLineOrigins(frame: CFTypeRef, range: CFRange, origins: *mut CGPoint);
    fn CTLineGetStringRange(line: CFTypeRef) -> CFRange;
    fn CTLineGetOffsetForStringIndex(
        line: CFTypeRef,
        char_index: CFIndex,
        secondary: *mut CGFloat,
    ) -> CGFloat;
    fn CTLineGetTypographicBounds(
        line: CFTypeRef,
        ascent: *mut CGFloat,
        descent: *mut CGFloat,
        leading: *mut CGFloat,
    ) -> f64;
    fn CTFontManagerCreateFontDescriptorsFromURL(file_url: CFTypeRef) -> CFTypeRef;
    fn CTFontCreateWithFontDescriptor(
        descriptor: CFTypeRef,
        size: CGFloat,
        matrix: *const c_void,
    ) -> CFTypeRef;
    fn CTFontGetAscent(font: CFTypeRef) -> CGFloat;
    fn CTFontGetDescent(font: CFTypeRef) -> CGFloat;
    fn CTFontCopyFamilyName(font: CFTypeRef) -> CFTypeRef;
    fn CTFontGetSymbolicTraits(font: CFTypeRef) -> u32;

    static kCTFontAttributeName: CFTypeRef;
    static kCTForegroundColorAttributeName: CFTypeRef;
    static kCTUnderlineStyleAttributeName: CFTypeRef;
    static kCTParagraphStyleAttributeName: CFTypeRef;
    static kCTStrokeWidthAttributeName: CFTypeRef;
    static kCTStrokeColorAttributeName: CFTypeRef;
    static kCTKernAttributeName: CFTypeRef;
    fn CTLineGetTrailingWhitespaceWidth(line: CFTypeRef) -> f64;
}

/// Garde RAII sur un CFType : `CFRelease` au Drop. Sans elle, chaque rastérisation fuit
/// une police, une couleur, un framesetter et une frame — et la rastérisation est
/// re-déclenchée à chaque changement du texte.
struct CFOwned(CFTypeRef);

impl CFOwned {
    fn new(r: CFTypeRef) -> Option<CFOwned> {
        if r.is_null() {
            None
        } else {
            Some(CFOwned(r))
        }
    }
    fn get(&self) -> CFTypeRef {
        self.0
    }
}

impl Drop for CFOwned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

// ---------------------------------------------------------------------------
// Modèle de boîte du bloc de texte
// ---------------------------------------------------------------------------

/// Marge et rayon de la plaque : `crate::text_plate`, partagé avec le rendu Direct2D.
/// Les deux plateformes DOIVENT lire les mêmes nombres — cf. l'en-tête de ce module.
fn plate_padding(font_px: CGFloat) -> (CGFloat, CGFloat) {
    let (x, y) = crate::text_plate::padding(font_px as f32);
    (x as CGFloat, y as CGFloat)
}

/// `CTTextAlignment` : 0 = left, 1 = right, 2 = center (3 = justified, 4 = natural).
fn ct_alignment(align: &str) -> u8 {
    match align {
        "left" => 0,
        "right" => 1,
        _ => 2,
    }
}

/// Où poser le cadre de mise en page et la plaque de fond dans une boîte `box_w`×`box_h`,
/// une fois le bloc mesuré à `text_w`×`text_h`.
///
/// Repère **CoreGraphics** : origine en BAS à gauche, `y` croissant vers le haut. Le
/// bitmap, lui, range sa ligne 0 en HAUT — d'où la conversion `box_h - haut - hauteur`,
/// faite ici une fois pour toutes plutôt que dispersée dans les appels de dessin.
///
/// Deux choses que la version précédente ne faisait pas :
///
/// * **centrage vertical.** `CTFrameDraw` remplit son cadre du haut vers le bas ; avec un
///   cadre couvrant toute la boîte, les lignes se collaient en haut et laissaient le reste
///   vide. Une bande de sous-titres fait 22 % de la hauteur de l'image
///   (`CAPTION_BAND_HEIGHT_PCT`, volontairement généreuse pour absorber deux lignes), donc
///   « le reste » représentait ~180 px sur 238 en 1080p. C'est l'énorme marge basse.
///   Windows n'avait pas le problème : `DWRITE_PARAGRAPH_ALIGNMENT_CENTER`.
///
///   Ce centrage est aussi la raison pour laquelle une bande de sous-titres peut désormais
///   déborder du cadre : côté app, `captionOffsetRange` la laisse sortir exactement de sa
///   marge vide, sinon les lettres s'arrêteraient à une demi-bande du bord (issue #396).
///   La boîte déborde, l'encre non — rien à changer ici.
/// * **plaque ajustée au texte.** Le fond couvrait la boîte entière, là où le `<span>` du
///   DOM, le renderer canvas et Direct2D (qui remplit `DWRITE_TEXT_METRICS`) l'ajustent
///   tous au bloc mis en page.
///
/// Le cadre garde toute la largeur utile (`box_w` moins la marge de plaque) : c'est sur
/// elle que CoreText applique l'alignement de paragraphe, exactement comme DirectWrite.
/// L'inset horizontal joue le rôle du `p-2` que l'overlay DOM posait sur le conteneur — il
/// réserve la place de la marge de plaque, pour qu'un texte aligné à gauche ou à droite ne
/// la voie pas rognée par le bord de la boîte.
fn block_layout(
    box_w: CGFloat,
    box_h: CGFloat,
    text_w: CGFloat,
    text_h: CGFloat,
    align: u8,
    valign: &str,
    // Une plaque de fond est-elle dessinée ? Elle décide de la marge à réserver du côté
    // ancré — voir `anchor_pad` plus bas. (Commentaire ordinaire et pas `///` : rustc
    // refuse un doc-comment sur un paramètre.)
    has_plate: bool,
    font_px: CGFloat,
) -> (CGRect, CGRect) {
    let (pad_x, pad_y) = plate_padding(font_px);
    let avail_w = layout_width(box_w, font_px);

    // Un cadre haut d'exactement `text_h` perd parfois sa dernière ligne sur un arrondi de
    // la mesure. On l'étend d'un pixel vers le BAS — donc en abaissant l'origine `y`, pas
    // en montant le sommet — pour que le haut du texte ne bouge pas d'un poil.
    const GUARD: CGFloat = 1.0;
    // ANCRAGE. `center` reste le comportement historique (et celui des annotations,
    // qui reproduisent `alignItems: center` de l'overlay web). Les sous-titres
    // épinglent une arête : un bloc centré voit ses DEUX arêtes bouger quand il
    // gagne une ligne, ce qui déplaçait le sous-titre. `top` est ici une distance
    // depuis le HAUT de la boîte, en coordonnées descendantes.
    // `anchor_pad` réserve la marge de la plaque DU CÔTÉ ANCRÉ. Sans elle, coller le
    // bloc de texte au bord laisse la plaque poser toute sa marge du côté opposé et
    // zéro du côté ancré : le fond épouse le bas des lettres au pixel près tout en
    // respirant deux fois trop au-dessus. Ce qui doit toucher le bord de la boîte est
    // la PLAQUE, pas les glyphes. Sans plaque, il n'y a rien à réserver.
    let anchor_pad = if has_plate { pad_y } else { 0.0 };
    let slack_y = (box_h - text_h).max(0.0);
    let top = match valign {
        "top" | "start" => anchor_pad,
        "bottom" | "end" => slack_y - anchor_pad,
        _ => slack_y * 0.5,
    }
    .clamp(0.0, slack_y);
    let frame_x = (box_w - avail_w) * 0.5;
    let frame = CGRect {
        origin: CGPoint {
            x: frame_x,
            y: box_h - top - text_h - GUARD,
        },
        size: CGSize {
            width: avail_w,
            height: text_h + GUARD,
        },
    };

    // La plaque épouse le bloc, marge comprise, sans jamais déborder de la boîte : au-delà
    // elle serait coupée net par le bord de la texture et perdrait ses coins arrondis.
    let plate_w = (text_w + pad_x * 2.0).min(box_w);
    let plate_h = (text_h + pad_y * 2.0).min(box_h);
    let slack_x = (box_w - plate_w).max(0.0);
    let plate_x = match align {
        // À gauche, les lignes commencent au bord gauche du cadre ; à droite, elles
        // finissent au bord droit. La plaque déborde de `pad_x` du côté concerné.
        0 => frame_x - pad_x,
        1 => frame_x + avail_w + pad_x - plate_w,
        _ => slack_x * 0.5,
    }
    .clamp(0.0, slack_x);
    let plate_y = (box_h - top - text_h - pad_y).clamp(0.0, (box_h - plate_h).max(0.0));

    (
        frame,
        CGRect {
            origin: CGPoint {
                x: plate_x,
                y: plate_y,
            },
            size: CGSize {
                width: plate_w,
                height: plate_h,
            },
        },
    )
}

/// Largeur offerte aux lignes — `crate::text_plate::layout_width`, en `CGFloat`.
fn layout_width(box_w: CGFloat, font_px: CGFloat) -> CGFloat {
    crate::text_plate::layout_width(box_w as f32, font_px as f32) as CGFloat
}

unsafe fn cf_string(s: &str) -> Option<CFOwned> {
    CFOwned::new(CFStringCreateWithBytes(
        std::ptr::null(),
        s.as_ptr(),
        s.len() as CFIndex,
        K_CF_STRING_ENCODING_UTF8,
        0,
    ))
}

/// Une police embarquée : sa famille, sa graisse, et le descripteur tiré DE SON FICHIER.
struct ShippedFace {
    family: String,
    bold: bool,
    descriptor: CFOwned,
}

// SAFETY : un `CTFontDescriptor` est immuable, et CoreText le déclare utilisable depuis
// n'importe quel thread. Rien d'autre dans la structure.
unsafe impl Send for ShippedFace {}
unsafe impl Sync for ShippedFace {}

/// Le texte d'une `CFString`, ou une chaîne vide.
unsafe fn cf_string_text(string: CFTypeRef) -> String {
    let mut buf = [0 as std::ffi::c_char; 256];
    let len = buf.len() as CFIndex;
    if CFStringGetCString(string, buf.as_mut_ptr(), len, K_CF_STRING_ENCODING_UTF8) == 0 {
        return String::new();
    }
    std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
}

/// Les faces de `files` (`crate::text_fonts`), chacune tenue par un descripteur de SON fichier.
///
/// Pas de résolution par nom, et c'est tout l'objet : une police installée qui porte le même
/// nom de famille passerait devant la nôtre (un enregistrement `CTFontManager` en double est
/// même refusé), et le rendu dépendrait à nouveau de la machine. Un descripteur tiré de l'URL
/// désigne ce fichier et aucun autre. Rien n'est enregistré ni installé.
///
/// Un fichier illisible ne coûte que sa police : sa famille retombe sur `CTFontCreateWithName`.
unsafe fn load_faces(files: &[PathBuf]) -> Vec<ShippedFace> {
    use std::os::unix::ffi::OsStrExt;
    let mut faces = Vec::new();
    for path in files {
        let bytes = path.as_os_str().as_bytes();
        let url = CFOwned::new(CFURLCreateFromFileSystemRepresentation(
            std::ptr::null(),
            bytes.as_ptr(),
            bytes.len() as CFIndex,
            0,
        ));
        let Some(descriptors) =
            url.and_then(|url| CFOwned::new(CTFontManagerCreateFontDescriptorsFromURL(url.get())))
        else {
            eprintln!("[text] police non chargée : {}", path.display());
            continue;
        };
        for i in 0..CFArrayGetCount(descriptors.get()) {
            let descriptor = CFArrayGetValueAtIndex(descriptors.get(), i);
            let Some(probe) =
                CFOwned::new(CTFontCreateWithFontDescriptor(descriptor, 12.0, std::ptr::null()))
            else {
                continue;
            };
            let Some(family) = CFOwned::new(CTFontCopyFamilyName(probe.get())) else {
                continue;
            };
            faces.push(ShippedFace {
                family: cf_string_text(family.get()),
                bold: CTFontGetSymbolicTraits(probe.get()) & K_CT_FONT_TRAIT_BOLD != 0,
                // Le tableau ne fait que prêter ses éléments : on en prend une référence.
                descriptor: CFOwned(CFRetain(descriptor)),
            });
        }
    }
    faces
}

/// Rastériseur de texte macOS. Pas d'état propre : CoreText et CoreGraphics sont prêts dès
/// le link des frameworks. Il ne tient que les polices embarquées, chargées une fois par
/// processus (chaque compositeur, preview comme export, crée son rastériseur).
pub struct TextRasterizer {
    faces: &'static [ShippedFace],
    /// Les derniers textes à effets, sans ce qui bouge : le plasma n'a qu'à repeindre ses lettres.
    /// Plusieurs : un titre et des sous-titres qui bougent à la fois ne doivent pas s'évincer.
    still: std::sync::Mutex<Vec<StillLayers>>,
}

/// Tout ce qui ne dépend pas du temps, et ce qu'il reste à peindre par-dessus à chaque image.
struct StillLayers {
    key: u64,
    base: Vec<u8>,
    moving: Vec<(Vec<u8>, Paint)>,
}

impl TextRasterizer {
    pub fn new() -> Result<TextRasterizer> {
        static FACES: std::sync::OnceLock<Vec<ShippedFace>> = std::sync::OnceLock::new();
        let faces = FACES
            .get_or_init(|| unsafe { load_faces(&crate::text_fonts::embedded_font_files()) });
        Ok(TextRasterizer { faces, still: std::sync::Mutex::new(Vec::new()) })
    }

    /// La police de `family` à cette taille, tirée du fichier embarqué qui a la graisse
    /// demandée. `None` pour une famille qui ne vient pas de l'app.
    unsafe fn shipped_font(&self, family: &str, bold: bool, size: CGFloat) -> Option<CFOwned> {
        // Une famille d'une seule graisse répond aux deux : une police de titre n'a qu'un fichier.
        let face = self
            .faces
            .iter()
            .find(|f| f.family == family && f.bold == bold)
            .or_else(|| self.faces.iter().find(|f| f.family == family))?;
        CFOwned::new(CTFontCreateWithFontDescriptor(face.descriptor.get(), size, std::ptr::null()))
    }

    /// La police de `family` : une famille embarquée vient de SON fichier, graisse comprise, les
    /// autres par nom. Gras/italique : une variante symbolique de la même famille. Si la famille
    /// n'a pas la variante, CoreText renvoie NULL — on garde alors la police de base plutôt que
    /// d'échouer sur un détail de style. Le gras d'une famille embarquée est déjà son fichier gras.
    unsafe fn font_for(
        &self,
        family: &str,
        bold: bool,
        italic: bool,
        size: CGFloat,
    ) -> Result<CFOwned> {
        let base_font = match self.shipped_font(family, bold, size) {
            Some(font) => font,
            None => {
                let name = cf_string(family);
                CFOwned::new(CTFontCreateWithName(
                    name.as_ref().map(|f| f.get()).unwrap_or(std::ptr::null()),
                    size,
                    std::ptr::null(),
                ))
                .ok_or_else(|| anyhow!("CTFontCreateWithName a renvoyé NULL"))?
            }
        };
        let shipped = self.faces.iter().any(|f| f.family == family);
        let mut traits = 0u32;
        if bold && !shipped {
            traits |= K_CT_FONT_TRAIT_BOLD;
        }
        if italic {
            traits |= K_CT_FONT_TRAIT_ITALIC;
        }
        if traits != 0 {
            let styled = CFOwned::new(CTFontCreateCopyWithSymbolicTraits(
                base_font.get(),
                0.0, // 0 = conserver la taille de la police source
                std::ptr::null(),
                traits,
                // Le masque ne touche que ce qu'on demande : l'italique d'une famille
                // embarquée ne doit pas lui retirer son gras.
                if shipped {
                    K_CT_FONT_TRAIT_ITALIC
                } else {
                    K_CT_FONT_TRAIT_BOLD | K_CT_FONT_TRAIT_ITALIC
                },
            ));
            if let Some(styled) = styled {
                return Ok(styled);
            }
        }
        Ok(base_font)
    }

    /// Le texte avec ses parties : couleur et police de chacune.
    unsafe fn with_runs(
        &self,
        attributed: CFTypeRef,
        spec: &TextSpec,
        space: CFTypeRef,
        size: CGFloat,
    ) -> Result<CFOwned> {
        let text = CFOwned::new(CFAttributedStringCreateMutableCopy(std::ptr::null(), 0, attributed))
            .ok_or_else(|| anyhow!("CFAttributedStringCreateMutableCopy NULL"))?;
        let tracking = spec.fx.as_ref().map_or(0.0, |fx| fx.tracking_em);
        if tracking != 0.0 {
            let kern = tracking as CGFloat * size;
            let number = CFOwned::new(CFNumberCreate(
                std::ptr::null(),
                K_CF_NUMBER_FLOAT64_TYPE,
                &kern as *const CGFloat as *const c_void,
            ))
            .ok_or_else(|| anyhow!("CFNumberCreate NULL"))?;
            let all = CFRange { location: 0, length: CFAttributedStringGetLength(text.get()) };
            CFAttributedStringSetAttribute(text.get(), all, kCTKernAttributeName, number.get());
        }
        for run in &spec.runs {
            let range = CFRange { location: run.start as CFIndex, length: run.len as CFIndex };
            if let Some(color) = run.color {
                let cg = cg_color(space, color)?;
                CFAttributedStringSetAttribute(
                    text.get(),
                    range,
                    kCTForegroundColorAttributeName,
                    cg.get(),
                );
            }
            if run.font_family.is_some() || run.italic || run.size_mul != 1.0 {
                let family = run.font_family.as_deref().unwrap_or(&spec.font_family);
                let font =
                    self.font_for(family, spec.bold, run.italic, size * run.size_mul as CGFloat)?;
                CFAttributedStringSetAttribute(text.get(), range, kCTFontAttributeName, font.get());
            }
        }
        Ok(text)
    }

    /// Rastérise `spec` dans une `MTLTexture` BGRA8Unorm neuve (alpha prémultiplié).
    ///
    /// Rend la texture **possédée** — la version précédente renvoyait `texture.as_ptr()`
    /// alors que le `metal::Texture` local était droppé au `return`, soit un
    /// `id<MTLTexture>` déjà relâché.
    pub unsafe fn rasterize(&self, gpu: &Gpu, spec: &TextSpec) -> Result<metal::Texture> {
        let margin = spec.margin_px() as usize;
        let (inner_w, inner_h) = (spec.box_px[0].max(1) as usize, spec.box_px[1].max(1) as usize);
        let (w, h) = (inner_w + margin * 2, inner_h + margin * 2);
        if spec.content.is_empty() {
            bail!("text_macos::rasterize: texte vide");
        }

        let bytes_per_row = w * 4;
        let mut buffer: Vec<u8> = vec![0u8; bytes_per_row * h];

        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            bail!("CGColorSpaceCreateDeviceRGB a renvoyé NULL");
        }
        let ctx = CGBitmapContextCreate(
            buffer.as_mut_ptr() as *mut c_void,
            w,
            h,
            8,
            bytes_per_row,
            space,
            CG_BITMAP_INFO_BGRA_PREMUL,
        );
        if ctx.is_null() {
            CGColorSpaceRelease(space);
            bail!("CGBitmapContextCreate {w}x{h} a renvoyé NULL");
        }

        // PAS de flip du CTM, et c'est contre-intuitif. `CGBitmapContext` a bien son origine
        // en bas à gauche, MAIS il stocke la ligne 0 du buffer EN HAUT de l'image — et
        // `CTFrameDraw` remplit son cadre du haut vers le bas. Le sommet du cadre atterrit
        // donc déjà dans les premières lignes du buffer, c'est-à-dire en haut de la
        // `MTLTexture`. Le `ScaleCTM(1, -1)` que ce code faisait retournait une image déjà
        // correcte : le texte s'affichait en miroir vertical.

        let drawn =
            self.draw_text(ctx, space, spec, inner_w as CGFloat, inner_h as CGFloat, buffer.as_mut_ptr());

        CGContextRelease(ctx);
        CGColorSpaceRelease(space);
        drawn?;

        let desc = metal::TextureDescriptor::new();
        desc.set_texture_type(metal::MTLTextureType::D2);
        desc.set_pixel_format(metal::MTLPixelFormat::BGRA8Unorm);
        desc.set_width(w as u64);
        desc.set_height(h as u64);
        desc.set_usage(metal::MTLTextureUsage::ShaderRead);
        desc.set_storage_mode(crate::compositor_macos::cpu_storage(&gpu.device));
        let texture = gpu.device.new_texture(&desc);

        texture.replace_region(
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
            buffer.as_ptr() as *const c_void,
            bytes_per_row as u64,
        );

        Ok(texture)
    }

    /// Le corps CoreText, isolé pour que `rasterize` puisse relâcher contexte et
    /// colorspace sur TOUS les chemins de sortie, y compris les `?`.
    unsafe fn draw_text(
        &self,
        ctx: CFTypeRef,
        space: CFTypeRef,
        spec: &TextSpec,
        box_w: CGFloat,
        box_h: CGFloat,
        data: *mut u8,
    ) -> Result<()> {
        let content =
            cf_string(&spec.content).ok_or_else(|| anyhow!("CFStringCreateWithBytes NULL"))?;

        // --- police ---
        let size = spec.font_size_px.max(1.0) as CGFloat;
        let font = self.font_for(&spec.font_family, spec.bold, spec.italic, size)?;

        // --- couleur ---
        let components: [CGFloat; 4] = [
            spec.color[0] as CGFloat,
            spec.color[1] as CGFloat,
            spec.color[2] as CGFloat,
            spec.color[3] as CGFloat,
        ];
        let color = CFOwned::new(CGColorCreate(space, components.as_ptr()))
            .ok_or_else(|| anyhow!("CGColorCreate a renvoyé NULL"))?;

        // --- alignement ---
        let alignment: u8 = ct_alignment(&spec.align);
        let leading = spec.fx.as_ref().map_or(0.0, |fx| fx.leading) as CGFloat;
        let mut settings = vec![CTParagraphStyleSetting {
            spec: K_CT_PARAGRAPH_STYLE_SPECIFIER_ALIGNMENT,
            value_size: std::mem::size_of::<u8>(),
            value: &alignment as *const u8 as *const c_void,
        }];
        if leading > 0.0 {
            settings.push(CTParagraphStyleSetting {
                spec: K_CT_PARAGRAPH_STYLE_SPECIFIER_LINE_HEIGHT_MULTIPLE,
                value_size: std::mem::size_of::<CGFloat>(),
                value: &leading as *const CGFloat as *const c_void,
            });
        }
        let paragraph = CFOwned::new(CTParagraphStyleCreate(settings.as_ptr(), settings.len()));

        // --- soulignement ---
        let underline_value: i32 = 1;
        let underline = if spec.underline {
            CFOwned::new(CFNumberCreate(
                std::ptr::null(),
                K_CF_NUMBER_S_INT32_TYPE,
                &underline_value as *const i32 as *const c_void,
            ))
        } else {
            None
        };

        // --- dictionnaire d'attributs ---
        let mut keys: Vec<CFTypeRef> = vec![kCTFontAttributeName, kCTForegroundColorAttributeName];
        let mut values: Vec<CFTypeRef> = vec![font.get(), color.get()];
        if let Some(p) = paragraph.as_ref() {
            keys.push(kCTParagraphStyleAttributeName);
            values.push(p.get());
        }
        if let Some(u) = underline.as_ref() {
            keys.push(kCTUnderlineStyleAttributeName);
            values.push(u.get());
        }
        let attrs = CFOwned::new(CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as CFIndex,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        ))
        .ok_or_else(|| anyhow!("CFDictionaryCreate (attributs) a renvoyé NULL"))?;

        let attributed = CFOwned::new(CFAttributedStringCreate(
            std::ptr::null(),
            content.get(),
            attrs.get(),
        ))
        .ok_or_else(|| anyhow!("CFAttributedStringCreate a renvoyé NULL"))?;

        // La mise en page se fait sur le texte AVEC ses parties : un mot d'accent deux fois plus
        // grand change les lignes.
        let attributed = self.with_runs(attributed.get(), spec, space, size)?;
        let framesetter = CFOwned::new(CTFramesetterCreateWithAttributedString(attributed.get()))
            .ok_or_else(|| anyhow!("CTFramesetterCreateWithAttributedString NULL"))?;

        // `length: 0` = « jusqu'à la fin de la chaîne », la convention CoreText — pas
        // besoin de compter les caractères (et surtout pas en `chars()`, qui compte des
        // scalaires Unicode là où CFAttributedString compte des unités UTF-16).
        let whole = CFRange {
            location: 0,
            length: 0,
        };

        // --- mesure du bloc mis en page ---
        // Hauteur non contrainte (`CGFLOAT_MAX`) : on veut la place que le texte PREND, pas
        // celle qu'on lui offre. Un texte plus haut que la boîte est ensuite recadré sur
        // elle, ce qui le rend coupé en bas plutôt que centré et coupé des deux côtés.
        let font_px = spec.font_size_px.max(1.0) as CGFloat;
        let avail_w = layout_width(box_w, font_px);
        let mut fit = whole;
        let measured = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter.get(),
            whole,
            std::ptr::null(),
            CGSize {
                width: avail_w,
                height: CGFloat::MAX,
            },
            &mut fit as *mut CFRange,
        );
        // Arrondi au pixel supérieur : la mesure revient parfois une fraction sous la
        // réalité, et il en faut peu pour rogner la dernière ligne.
        let text_w = measured.width.ceil().clamp(0.0, avail_w);
        let text_h = measured.height.ceil().max(0.0);

        let (mut frame_rect, mut plate_rect) =
            block_layout(
                box_w,
                box_h,
                text_w,
                text_h,
                alignment,
                &spec.valign,
                spec.background[3] > 0.0,
                font_px,
            );
        // La mise en page se fait dans la boîte ; elle est dessinée dans la texture, plus grande.
        let margin = spec.margin_px() as CGFloat;
        frame_rect.origin.x += margin;
        frame_rect.origin.y += margin;
        plate_rect.origin.x += margin;
        plate_rect.origin.y += margin;

        // --- plaque de fond, sous le texte ---
        if spec.background[3] > 0.0 && plate_rect.size.width > 0.0 && plate_rect.size.height > 0.0
        {
            let radius = crate::text_plate::radius(
                font_px as f32,
                plate_rect.size.width as f32,
                plate_rect.size.height as f32,
            ) as CGFloat;
            let plate = CFOwned::new(CGPathCreateWithRoundedRect(
                plate_rect,
                radius,
                radius,
                std::ptr::null(),
            ))
            .ok_or_else(|| anyhow!("CGPathCreateWithRoundedRect NULL"))?;
            CGContextSetRGBFillColor(
                ctx,
                spec.background[0] as CGFloat,
                spec.background[1] as CGFloat,
                spec.background[2] as CGFloat,
                spec.background[3] as CGFloat,
            );
            CGContextAddPath(ctx, plate.get());
            CGContextFillPath(ctx);
        }

        let path = CFOwned::new(CGPathCreateWithRect(frame_rect, std::ptr::null()))
            .ok_or_else(|| anyhow!("CGPathCreateWithRect NULL"))?;
        let frame = CFOwned::new(CTFramesetterCreateFrame(
            framesetter.get(),
            whole,
            path.get(),
            std::ptr::null(),
        ))
        .ok_or_else(|| anyhow!("CTFramesetterCreateFrame NULL"))?;

        // Une ligne de caractères vaut `font_em` tailles de police, descente comprise : ce qu'il faut
        // pour poser une boîte sur les lettres et non sur les marges de la police.
        let font_em = (CTFontGetAscent(font.get()) + CTFontGetDescent(font.get())) / font_px;
        let tight = |rect: CGRectDescent, em: CGFloat| -> CGRect {
            let size = rect.rect.size.height / em;
            let baseline = rect.rect.origin.y + rect.descent;
            CGRect {
                origin: CGPoint { x: rect.rect.origin.x, y: baseline - size * 0.27 },
                size: CGSize { width: rect.rect.size.width, height: size * 1.12 },
            }
        };

        // --- une boîte derrière chaque ligne ---
        if let Some((color, radius_em, pad_x_em, pad_y_em)) =
            spec.fx.as_ref().and_then(|fx| fx.line_plate)
        {
            let mut rects: Vec<CGRect> = line_rects(frame.get(), frame_rect)
                .into_iter()
                .map(|rect| tight(rect, font_em))
                .collect();
            if spec.fx.as_ref().is_some_and(|fx| fx.plate_block) && !rects.is_empty() {
                let left = rects.iter().map(|r| r.origin.x).fold(CGFloat::MAX, CGFloat::min);
                let right =
                    rects.iter().map(|r| r.origin.x + r.size.width).fold(CGFloat::MIN, CGFloat::max);
                let bottom = rects.iter().map(|r| r.origin.y).fold(CGFloat::MAX, CGFloat::min);
                let top =
                    rects.iter().map(|r| r.origin.y + r.size.height).fold(CGFloat::MIN, CGFloat::max);
                rects = vec![CGRect {
                    origin: CGPoint { x: left, y: bottom },
                    size: CGSize { width: right - left, height: top - bottom },
                }];
            }
            for rect in rects {
                let (pad_x, pad_y) = (pad_x_em as CGFloat * font_px, pad_y_em as CGFloat * font_px);
                let plate = CGRect {
                    origin: CGPoint { x: rect.origin.x - pad_x, y: rect.origin.y - pad_y },
                    size: CGSize {
                        width: rect.size.width + pad_x * 2.0,
                        height: rect.size.height + pad_y * 2.0,
                    },
                };
                let radius = (radius_em as CGFloat * font_px).min(plate.size.height * 0.5);
                let path =
                    CFOwned::new(CGPathCreateWithRoundedRect(plate, radius, radius, std::ptr::null()))
                        .ok_or_else(|| anyhow!("CGPathCreateWithRoundedRect NULL"))?;
                CGContextSetRGBFillColor(
                    ctx,
                    color[0] as CGFloat,
                    color[1] as CGFloat,
                    color[2] as CGFloat,
                    color[3] as CGFloat,
                );
                CGContextAddPath(ctx, path.get());
                CGContextFillPath(ctx);
            }
        }

        // --- pastilles, sous tout le reste ---
        for run in spec.runs.iter().filter(|run| run.pill.is_some()) {
            let color = run.pill.unwrap_or_default();
            // Elle glisse depuis le mot d'avant : le regard suit au lieu de sauter.
            let from = run.pill_from.and_then(|(start, len)| {
                let before = TextRunSpec { start, len, ..run.clone() };
                run_rects(frame.get(), frame_rect, &before).into_iter().next()
            });
            let slide = (spec.elapsed_ms / SLIDE_MS).clamp(0.0, 1.0) as CGFloat;
            let slide = 1.0 - (1.0 - slide) * (1.0 - slide);
            for rect in run_rects(frame.get(), frame_rect, run) {
                let rect = tight(rect, font_em);
                let from = from.map(|from| tight(from, font_em));
                let rect = match from {
                    // Pas d'une ligne à l'autre : elle traverserait le texte.
                    Some(from) if (from.origin.y - rect.origin.y).abs() < 1.0 => CGRect {
                        origin: CGPoint {
                            x: from.origin.x + (rect.origin.x - from.origin.x) * slide,
                            y: rect.origin.y,
                        },
                        size: CGSize {
                            width: from.size.width + (rect.size.width - from.size.width) * slide,
                            height: rect.size.height,
                        },
                    },
                    _ => rect,
                };
                let h = rect.size.height;
                let pad = font_px * 0.1;
                let pill = CGRect {
                    origin: CGPoint { x: rect.origin.x - pad * 1.4, y: rect.origin.y - pad * 0.4 },
                    size: CGSize { width: rect.size.width + pad * 2.8, height: h + pad * 0.8 },
                };
                let radius = (h * 0.24).min(pill.size.width * 0.5);
                let path =
                    CFOwned::new(CGPathCreateWithRoundedRect(pill, radius, radius, std::ptr::null()))
                        .ok_or_else(|| anyhow!("CGPathCreateWithRoundedRect NULL"))?;
                CGContextSetRGBFillColor(
                    ctx,
                    color[0] as CGFloat,
                    color[1] as CGFloat,
                    color[2] as CGFloat,
                    color[3] as CGFloat,
                );
                CGContextAddPath(ctx, path.get());
                CGContextFillPath(ctx);
            }
        }

        if spec.wants_fx() {
            let (outer_w, outer_h) = ((box_w + margin * 2.0) as usize, (box_h + margin * 2.0) as usize);
            let out = std::slice::from_raw_parts_mut(data, outer_w * outer_h * 4);
            return self.draw_fx(
                space,
                spec,
                attributed.get(),
                path.get(),
                frame.get(),
                frame_rect,
                font_px,
                font_em,
                outer_w,
                outer_h,
                out,
            );
        }

        // Le même texte, mis en page pareil, avec d'autres attributs : une passe de plus.
        let draw_variant = |edit: &dyn Fn(CFTypeRef) -> Result<()>| -> Result<()> {
            let copy = CFOwned::new(CFAttributedStringCreateMutableCopy(
                std::ptr::null(),
                0,
                attributed.get(),
            ))
            .ok_or_else(|| anyhow!("CFAttributedStringCreateMutableCopy NULL"))?;
            edit(copy.get())?;
            let setter = CFOwned::new(CTFramesetterCreateWithAttributedString(copy.get()))
                .ok_or_else(|| anyhow!("CTFramesetterCreateWithAttributedString NULL"))?;
            let variant = CFOwned::new(CTFramesetterCreateFrame(
                setter.get(),
                whole,
                path.get(),
                std::ptr::null(),
            ))
            .ok_or_else(|| anyhow!("CTFramesetterCreateFrame NULL"))?;
            CTFrameDraw(variant.get(), ctx);
            Ok(())
        };
        let set_shadow = |shadow: ([f32; 4], f32, f32)| -> Result<()> {
            let (color, blur_em, y_em) = shadow;
            let cg = cg_color(space, color)?;
            CGContextSetShadowWithColor(
                ctx,
                CGSize { width: 0.0, height: -(y_em as CGFloat) * font_px },
                blur_em as CGFloat * font_px,
                cg.get(),
            );
            Ok(())
        };

        // --- halo d'un mot : le reste du texte est invisible dans cette passe ---
        for run in spec.runs.iter().filter(|run| run.glow.is_some()) {
            let glow = run.glow.unwrap_or_default();
            CGContextSaveGState(ctx);
            set_shadow((glow, 0.45, 0.0))?;
            draw_variant(&|text| {
                let clear = cg_color(space, [0.0, 0.0, 0.0, 0.0])?;
                let all = CFRange { location: 0, length: CFAttributedStringGetLength(text) };
                CFAttributedStringSetAttribute(
                    text,
                    all,
                    kCTForegroundColorAttributeName,
                    clear.get(),
                );
                let own = cg_color(space, glow)?;
                CFAttributedStringSetAttribute(
                    text,
                    CFRange { location: run.start as CFIndex, length: run.len as CFIndex },
                    kCTForegroundColorAttributeName,
                    own.get(),
                );
                Ok(())
            })?;
            CGContextRestoreGState(ctx);
        }

        // --- contour, avec l'ombre : les lettres se posent dessus ---
        if let Some((stroke_color, em)) = spec.stroke {
            CGContextSaveGState(ctx);
            CGContextSetLineJoin(ctx, K_CG_LINE_JOIN_ROUND);
            if let Some(shadow) = spec.shadow {
                set_shadow(shadow)?;
            }
            draw_variant(&|text| {
                // Positif = contour seul, en pourcentage de la police. La moitié est sous le
                // remplissage, d'où le double.
                let width = (em * 200.0) as CGFloat;
                let number = CFOwned::new(CFNumberCreate(
                    std::ptr::null(),
                    K_CF_NUMBER_FLOAT64_TYPE,
                    &width as *const CGFloat as *const c_void,
                ))
                .ok_or_else(|| anyhow!("CFNumberCreate NULL"))?;
                let cg = cg_color(space, stroke_color)?;
                let all = CFRange { location: 0, length: CFAttributedStringGetLength(text) };
                CFAttributedStringSetAttribute(text, all, kCTStrokeWidthAttributeName, number.get());
                CFAttributedStringSetAttribute(text, all, kCTStrokeColorAttributeName, cg.get());
                Ok(())
            })?;
            CGContextRestoreGState(ctx);
            CTFrameDraw(frame.get(), ctx);
            return Ok(());
        }

        CGContextSaveGState(ctx);
        if let Some(shadow) = spec.shadow {
            set_shadow(shadow)?;
        }
        CTFrameDraw(frame.get(), ctx);
        CGContextRestoreGState(ctx);
        Ok(())
    }

    /// La couverture de `ranges` à la même mise en page : lettres pleines, ou leur contour seul.
    #[allow(clippy::too_many_arguments)]
    unsafe fn text_mask(
        &self,
        space: CFTypeRef,
        attributed: CFTypeRef,
        path: CFTypeRef,
        (w, h): (usize, usize),
        ranges: &[(usize, usize)],
        stroke_em: Option<f32>,
        scale: Option<(CGFloat, CGFloat, CGFloat)>,
    ) -> Result<Vec<u8>> {
        let text = CFOwned::new(CFAttributedStringCreateMutableCopy(std::ptr::null(), 0, attributed))
            .ok_or_else(|| anyhow!("CFAttributedStringCreateMutableCopy NULL"))?;
        let all = CFRange { location: 0, length: CFAttributedStringGetLength(text.get()) };
        let clear = cg_color(space, [0.0, 0.0, 0.0, 0.0])?;
        let ink = cg_color(space, [0.0, 0.0, 0.0, 1.0])?;
        CFAttributedStringSetAttribute(text.get(), all, kCTForegroundColorAttributeName, clear.get());
        if let Some(em) = stroke_em {
            let width = (em * 200.0) as CGFloat;
            let number = CFOwned::new(CFNumberCreate(
                std::ptr::null(),
                K_CF_NUMBER_FLOAT64_TYPE,
                &width as *const CGFloat as *const c_void,
            ))
            .ok_or_else(|| anyhow!("CFNumberCreate NULL"))?;
            CFAttributedStringSetAttribute(text.get(), all, kCTStrokeWidthAttributeName, number.get());
            CFAttributedStringSetAttribute(text.get(), all, kCTStrokeColorAttributeName, clear.get());
        }
        for &(start, len) in ranges {
            let range = CFRange { location: start as CFIndex, length: len as CFIndex };
            let key = if stroke_em.is_some() {
                kCTStrokeColorAttributeName
            } else {
                kCTForegroundColorAttributeName
            };
            CFAttributedStringSetAttribute(text.get(), range, key, ink.get());
        }
        let setter = CFOwned::new(CTFramesetterCreateWithAttributedString(text.get()))
            .ok_or_else(|| anyhow!("CTFramesetterCreateWithAttributedString NULL"))?;
        let frame = CFOwned::new(CTFramesetterCreateFrame(
            setter.get(),
            CFRange { location: 0, length: 0 },
            path,
            std::ptr::null(),
        ))
        .ok_or_else(|| anyhow!("CTFramesetterCreateFrame NULL"))?;
        let mut mask = vec![0u8; w * h];
        let ctx = CGBitmapContextCreate(
            mask.as_mut_ptr() as *mut c_void,
            w,
            h,
            8,
            w,
            std::ptr::null(),
            CG_IMAGE_ALPHA_ONLY,
        );
        if ctx.is_null() {
            bail!("CGBitmapContextCreate (masque) {w}x{h} a renvoyé NULL");
        }
        CGContextSetLineJoin(ctx, K_CG_LINE_JOIN_ROUND);
        if let Some((cx, cy, s)) = scale {
            CGContextTranslateCTM(ctx, cx, cy);
            CGContextScaleCTM(ctx, s, s);
            CGContextTranslateCTM(ctx, -cx, -cy);
        }
        CTFrameDraw(frame.get(), ctx);
        CGContextRelease(ctx);
        Ok(mask)
    }

    /// Les passes de `text_fx`. Le plaque et les pastilles sont déjà dans `out`.
    ///
    /// Un mot qui grandit passe à part : son échelle change à chaque image de son entrée, et il
    /// doit se poser au-dessus de ses voisins. Tout le reste est calculé une fois et gardé
    /// (`StillLayers`) : seules les lettres en mouvement sont repeintes ensuite.
    #[allow(clippy::too_many_arguments)]
    unsafe fn draw_fx(
        &self,
        space: CFTypeRef,
        spec: &TextSpec,
        attributed: CFTypeRef,
        path: CFTypeRef,
        frame: CFTypeRef,
        frame_rect: CGRect,
        font_px: CGFloat,
        font_em: CGFloat,
        w: usize,
        h: usize,
        out: &mut [u8],
    ) -> Result<()> {
        let default_fx = TextFx::default();
        let fx = spec.fx.as_ref().unwrap_or(&default_fx);
        let t = spec.scene_ms / 1000.0;
        let px = font_px as f32;
        let entering = fx.enter.is_some() && spec.elapsed_ms < ENTER_MS;
        let popping = spec.elapsed_ms < POP_WINDOW_MS && spec.runs.iter().any(|run| run.pops());
        // Un mot qui grandit et une pastille qui glisse changent à chaque image de leur entrée.
        let sliding =
            spec.elapsed_ms < SLIDE_MS && spec.runs.iter().any(|run| run.pill_from.is_some());
        let can_keep = !popping && !sliding;
        let still_key = spec.still_key();

        let mut kept = self.still.lock().unwrap_or_else(|e| e.into_inner());
        if can_keep {
            if let Some(still) = kept.iter().find(|still| still.key == still_key) {
                out.copy_from_slice(&still.base);
                for (mask, paint) in &still.moving {
                    paint.draw(out, mask, t);
                }
                if let (true, Some(kind)) = (entering, fx.enter.as_deref()) {
                    text_fx::apply_enter(out, w, h, kind, spec.elapsed_ms, px);
                }
                return Ok(());
            }
        }

        let length = CFAttributedStringGetLength(attributed) as usize;
        let line_bands = line_bands(frame, frame_rect, h as CGFloat, font_em);
        let line_of_row = text_fx::lines_of_rows(h, &line_bands);

        let hidden: Vec<(usize, usize)> =
            spec.runs.iter().filter(|run| run.hide).map(|run| (run.start, run.len)).collect();
        let popped: Vec<&TextRunSpec> = spec.runs.iter().filter(|run| run.pops() && !run.hide).collect();
        let cut: Vec<(usize, usize)> =
            hidden.iter().copied().chain(popped.iter().map(|run| (run.start, run.len))).collect();

        // Le reste du texte d'abord, puis chaque mot qui grandit, au-dessus.
        let mut groups: Vec<(Vec<(usize, usize)>, Option<(CGFloat, CGFloat, CGFloat)>)> =
            vec![(without(length, &cut), None)];
        for run in &popped {
            let scale = text_fx::pop_scale(spec.elapsed_ms, run.pop_peak, run.pop_hold) as CGFloat;
            let centre = run_rects(frame, frame_rect, run).first().map(|r| {
                (r.rect.origin.x + r.rect.size.width * 0.5, r.rect.origin.y + r.rect.size.height * 0.5)
            });
            let Some((cx, cy)) = centre else { continue };
            groups.push((vec![(run.start, run.len)], Some((cx, cy, scale))));
        }

        let mut moving: Vec<(Vec<u8>, Paint)> = Vec::new();
        for (ranges, scale) in groups {
            if ranges.is_empty() {
                continue;
            }
            let fill_all = self.text_mask(space, attributed, path, (w, h), &ranges, None, scale)?;
            let stroke_all = match spec.stroke {
                Some((_, em)) => {
                    Some(self.text_mask(space, attributed, path, (w, h), &ranges, Some(em), scale)?)
                }
                None => None,
            };
            let outline = match stroke_all.as_ref() {
                Some(stroke) => text_fx::union(&fill_all, stroke),
                None => fill_all.clone(),
            };
            let bounds = text_fx::ink_bounds(&fill_all, w);

            // --- la lumière d'abord : tout le reste se pose dessus ---
            if let Some(glow) = fx.glow.as_ref().filter(|glow| !glow.colors.is_empty()) {
                let source = text_fx::to_float(&outline);
                // Une lumière ne se voit pas sur du clair : un peu de nuit derrière elle, et elle
                // tient aussi sur une chemise blanche, sans rien changer sur un fond sombre.
                let mut night = text_fx::blur(&source, w, h, glow.em * px * 0.5);
                night.iter_mut().for_each(|v| *v = (*v * 2.8).min(1.0));
                text_fx::over_soft(out, &night, [0.0, 0.0, 0.0, glow.night]);
                for (i, color) in glow.colors.iter().enumerate() {
                    let of_line: Vec<f32> = if glow.colors.len() == 1 {
                        source.clone()
                    } else {
                        source
                            .iter()
                            .enumerate()
                            .map(|(at, &v)| {
                                if line_of_row[at / w] as usize % glow.colors.len() == i {
                                    v
                                } else {
                                    0.0
                                }
                            })
                            .collect()
                    };
                    bloom(out, &of_line, w, h, *color, glow.em * px, glow.strength);
                }
            }
            for run in spec.runs.iter().filter(|run| run.glow.is_some() && !run.hide) {
                if !ranges.iter().any(|&(start, len)| run.start >= start && run.start + run.len <= start + len) {
                    continue;
                }
                let glow = run.glow.unwrap_or_default();
                let own =
                    self.text_mask(space, attributed, path, (w, h), &[(run.start, run.len)], None, scale)?;
                bloom(out, &text_fx::to_float(&own), w, h, [glow[0], glow[1], glow[2]], 0.5 * px, 1.0);
            }

            // --- ombres ---
            if let Some((color, x_em, y_em)) = fx.hard_shadow {
                let reach = text_fx::extrude(&outline, w, h, x_em * px, y_em * px);
                text_fx::over_solid(out, &reach, color);
            }
            if let Some((color, blur_em, y_em)) = spec.shadow {
                let moved = text_fx::extrude_once(&outline, w, h, 0.0, y_em * px);
                let soft = text_fx::blur(&text_fx::to_float(&moved), w, h, blur_em * px);
                text_fx::over_soft(out, &soft, color);
            }

            // --- contour ---
            if let (Some(stroke), Some((color, _))) = (stroke_all.as_ref(), spec.stroke) {
                text_fx::over_solid(out, stroke, color);
            }

            // --- les lettres : le texte courant, puis les mots qui ont leur propre couleur ---
            let coloured: Vec<&TextRunSpec> = spec
                .runs
                .iter()
                .filter(|run| !run.hide && (run.color.is_some() || run.fill.is_some()))
                .filter(|run| {
                    ranges.iter().any(|&(start, len)| run.start >= start && run.start + run.len <= start + len)
                })
                .collect();
            let needs_soft = fx.bevel > 0.0 || fx.fill.as_ref().is_some_and(|fill| fill.core > 0.0);
            let soft = if needs_soft {
                text_fx::blur(&text_fx::to_float(&fill_all), w, h, (0.035 * px).max(1.0))
            } else {
                Vec::new()
            };
            let paint_of = |fill: Option<FillSpec>, solid: [f32; 4], shine| Paint {
                fill,
                solid,
                shine,
                bevel: fx.bevel,
                font_px: px,
                bounds,
                lines: line_bands.clone(),
                line_of_row: line_of_row.clone(),
                soft: soft.clone(),
                w,
            };
            let hollow = fx.fill.as_ref().is_some_and(|fill| fill.kind == "none");
            let rest: Vec<(usize, usize)> = if coloured.is_empty() {
                ranges.clone()
            } else {
                let taken: Vec<(usize, usize)> =
                    coloured.iter().map(|run| (run.start, run.len)).collect();
                ranges
                    .iter()
                    .flat_map(|&(start, len)| clip_out(start, len, &taken))
                    .collect()
            };
            let mut layers: Vec<(Vec<u8>, Paint)> = Vec::new();
            if !hollow && !rest.is_empty() {
                let mask = if coloured.is_empty() {
                    fill_all.clone()
                } else {
                    self.text_mask(space, attributed, path, (w, h), &rest, None, scale)?
                };
                layers.push((mask, paint_of(fx.fill.clone(), spec.color, fx.shine.clone())));
            }
            for run in coloured {
                let mask =
                    self.text_mask(space, attributed, path, (w, h), &[(run.start, run.len)], None, scale)?;
                let solid = run.color.unwrap_or(spec.color);
                let fill = run.fill.clone();
                layers.push((mask, paint_of(fill, solid, fx.shine.clone())));
            }
            for (mask, paint) in layers {
                if paint.moves() {
                    moving.push((mask, paint));
                } else {
                    paint.draw(out, &mask, t);
                }
            }
        }

        if can_keep {
            const KEPT: usize = 4;
            if kept.len() >= KEPT {
                kept.remove(0);
            }
            let still = StillLayers { key: still_key, base: out.to_vec(), moving };
            for (mask, paint) in &still.moving {
                paint.draw(out, mask, t);
            }
            kept.push(still);
        } else {
            for (mask, paint) in &moving {
                paint.draw(out, mask, t);
            }
        }
        if let (true, Some(kind)) = (entering, fx.enter.as_deref()) {
            text_fx::apply_enter(out, w, h, kind, spec.elapsed_ms, px);
        }
        Ok(())
    }
}

/// Une lumière à trois portées : un cœur serré, un halo, et la lueur large qui fait croire à la
/// source. Une seule portée se lit comme une ombre colorée, pas comme de la lumière.
fn bloom(out: &mut [u8], source: &[f32], w: usize, h: usize, color: [f32; 3], reach: f32, strength: f32) {
    for (share, weight) in [(0.1, 0.7), (0.38, 0.6), (1.0, 0.55)] {
        let mut light = text_fx::blur(source, w, h, (reach * share).max(1.0));
        light.iter_mut().for_each(|v| *v *= weight * strength);
        text_fx::add_light(out, &light, color, 0.45);
    }
}

/// `[0, length)` sans `cut`.
fn without(length: usize, cut: &[(usize, usize)]) -> Vec<(usize, usize)> {
    clip_out(0, length, cut)
}

fn clip_out(start: usize, len: usize, cut: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut cut: Vec<(usize, usize)> = cut.to_vec();
    cut.sort_unstable();
    let end = start + len;
    let mut at = start;
    let mut out = Vec::new();
    for (from, n) in cut {
        let to = from + n;
        if to <= at || from >= end {
            continue;
        }
        if from > at {
            out.push((at, from - at));
        }
        at = at.max(to);
    }
    if at < end {
        out.push((at, end - at));
    }
    out
}

/// Chaque ligne du bloc en lignes du tampon : (haut, bas), de haut en bas.
unsafe fn line_bands(frame: CFTypeRef, frame_rect: CGRect, box_h: CGFloat, em: CGFloat) -> Vec<(f32, f32)> {
    // Le haut de la ligne à la base des lettres : un dégradé se lit sur elles, pas sur les marges.
    line_rects(frame, frame_rect)
        .into_iter()
        .map(|line| {
            let size = line.rect.size.height / em;
            let baseline = line.rect.origin.y + line.descent;
            let top = box_h - (baseline + size * 0.8);
            (top as f32, (box_h - (baseline - size * 0.06)) as f32)
        })
        .collect()
}

/// Le rectangle de chaque ligne, espaces de fin exclus.
unsafe fn line_rects(frame: CFTypeRef, frame_rect: CGRect) -> Vec<CGRectDescent> {
    let lines = CTFrameGetLines(frame);
    let count = CFArrayGetCount(lines);
    let mut origins = vec![CGPoint { x: 0.0, y: 0.0 }; count.max(0) as usize];
    CTFrameGetLineOrigins(frame, CFRange { location: 0, length: 0 }, origins.as_mut_ptr());
    (0..count)
        .map(|i| {
            let line = CFArrayGetValueAtIndex(lines, i);
            let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
            let width = CTLineGetTypographicBounds(line, &mut ascent, &mut descent, &mut leading)
                - CTLineGetTrailingWhitespaceWidth(line);
            let origin = origins[i as usize];
            CGRectDescent {
                rect: CGRect {
                    origin: CGPoint {
                        x: frame_rect.origin.x + origin.x,
                        y: frame_rect.origin.y + origin.y - descent,
                    },
                    size: CGSize { width: width.max(0.0), height: ascent + descent },
                },
                descent,
            }
        })
        .collect()
}

unsafe fn cg_color(space: CFTypeRef, color: [f32; 4]) -> Result<CFOwned> {
    let components = color.map(|c| c as CGFloat);
    CFOwned::new(CGColorCreate(space, components.as_ptr()))
        .ok_or_else(|| anyhow!("CGColorCreate a renvoyé NULL"))
}

/// Un rectangle de texte, et sa descente : la ligne de base est `origin.y + descent`.
#[derive(Clone, Copy)]
struct CGRectDescent {
    rect: CGRect,
    descent: CGFloat,
}

/// Où `run` tombe dans le bloc mis en page : un rectangle par ligne qu'il touche.
unsafe fn run_rects(frame: CFTypeRef, frame_rect: CGRect, run: &TextRunSpec) -> Vec<CGRectDescent> {
    let lines = CTFrameGetLines(frame);
    let count = CFArrayGetCount(lines);
    let mut origins = vec![CGPoint { x: 0.0, y: 0.0 }; count.max(0) as usize];
    CTFrameGetLineOrigins(frame, CFRange { location: 0, length: 0 }, origins.as_mut_ptr());
    let (from, to) = (run.start as CFIndex, (run.start + run.len) as CFIndex);
    let mut rects = Vec::new();
    for i in 0..count {
        let line = CFArrayGetValueAtIndex(lines, i);
        let range = CTLineGetStringRange(line);
        let (a, b) = (from.max(range.location), to.min(range.location + range.length));
        if a >= b {
            continue;
        }
        let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
        CTLineGetTypographicBounds(line, &mut ascent, &mut descent, &mut leading);
        let x0 = CTLineGetOffsetForStringIndex(line, a, std::ptr::null_mut());
        let x1 = CTLineGetOffsetForStringIndex(line, b, std::ptr::null_mut());
        let origin = origins[i as usize];
        rects.push(CGRectDescent {
            rect: CGRect {
                origin: CGPoint {
                    x: frame_rect.origin.x + origin.x + x0,
                    y: frame_rect.origin.y + origin.y - descent,
                },
                size: CGSize { width: x1 - x0, height: ascent + descent },
            },
            descent,
        });
    }
    rects
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(content: &str) -> TextSpec {
        TextSpec {
            content: content.into(),
            color: [1.0, 1.0, 1.0, 1.0],
            background: [0.0, 0.0, 0.0, 0.0],
            font_size_px: 48.0,
            font_family: "Helvetica".into(),
            bold: false,
            italic: false,
            underline: false,
            align: "center".into(),
            valign: "center".into(),
            box_px: [256, 256],
            runs: Vec::new(),
            stroke: None,
            shadow: None,
            fx: None,
            elapsed_ms: 0.0,
            scene_ms: 0.0,
        }
    }

    /// Le mot qui s'allume, sa pastille et le contour : des pixels de leur couleur, là où un texte
    /// uni n'en a aucun.
    #[test]
    fn a_word_can_light_up_and_letters_can_have_an_outline() {
        let count = |pixels: &[u8], test: fn(u8, u8, u8) -> bool| {
            pixels.chunks_exact(4).filter(|p| test(p[2], p[1], p[0])).count()
        };
        let red = |r: u8, g: u8, b: u8| r > 200 && g < 60 && b < 60;
        let blue = |r: u8, g: u8, b: u8| b > 200 && r < 60 && g < 60;
        let run = TextRunSpec {
            start: 0,
            len: 2,
            color: Some([1.0, 0.0, 0.0, 1.0]),
            pill: None,
            font_family: None,
            size_mul: 1.0,
            italic: false,
            glow: None,
            fill: None,
            pop_peak: 1.0,
            pop_hold: 1.0,
            hide: false,
            pill_from: None,
        };
        let Some((plain, _, _)) = raster_bgra(&spec("AB CD")) else { return };
        assert_eq!(count(&plain, red), 0);

        let mut lit = spec("AB CD");
        lit.runs = vec![run.clone()];
        let (pixels, _, _) = raster_bgra(&lit).unwrap();
        assert!(count(&pixels, red) > 20, "le mot n'est pas allumé");

        let mut pilled = spec("AB CD");
        pilled.runs = vec![TextRunSpec { color: None, pill: Some([0.0, 0.0, 1.0, 1.0]), ..run }];
        let (pixels, _, _) = raster_bgra(&pilled).unwrap();
        assert!(count(&pixels, blue) > 200, "pas de pastille");

        let mut outlined = spec("AB CD");
        outlined.stroke = Some(([0.0, 0.0, 1.0, 1.0], 0.06));
        let (pixels, _, _) = raster_bgra(&outlined).unwrap();
        assert!(count(&pixels, blue) > 50, "pas de contour");
    }

    /// Rastérise et rend les octets BGRA, ou `None` si la machine n'a pas de device Metal.
    fn raster_bgra(spec: &TextSpec) -> Option<(Vec<u8>, usize, usize)> {
        raster_bgra_with(&TextRasterizer::new().expect("TextRasterizer::new"), spec)
    }

    fn raster_bgra_with(
        raster: &TextRasterizer,
        spec: &TextSpec,
    ) -> Option<(Vec<u8>, usize, usize)> {
        let Ok(gpu) = crate::d3d::Gpu::create(false) else {
            eprintln!("pas de device Metal — test sauté");
            return None;
        };
        let tex = unsafe { raster.rasterize(&gpu, spec) }.expect("rasterize");
        let margin = spec.margin_px() as usize;
        let (w, h) = (spec.box_px[0] as usize + margin * 2, spec.box_px[1] as usize + margin * 2);
        let mut px = vec![0u8; w * h * 4];
        tex.get_bytes(
            px.as_mut_ptr() as *mut c_void,
            (w * 4) as u64,
            metal::MTLRegion {
                origin: metal::MTLOrigin { x: 0, y: 0, z: 0 },
                size: metal::MTLSize {
                    width: w as u64,
                    height: h as u64,
                    depth: 1,
                },
            },
            0,
        );
        Some((px, w, h))
    }

    /// Boîte englobante de l'encre (alpha > 8) : `(x0, y0, x1, y1)`, bornes incluses.
    fn ink_bounds(px: &[u8], w: usize, h: usize) -> (usize, usize, usize, usize) {
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
        for y in 0..h {
            for x in 0..w {
                if px[(y * w + x) * 4 + 3] > 8 {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
        }
        assert!(x0 <= x1 && y0 <= y1, "aucune encre : rien n'a été rastérisé");
        (x0, y0, x1, y1)
    }

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerRegisterFontsForURL(
            font_url: CFTypeRef,
            scope: u32,
            error: *mut CFTypeRef,
        ) -> bool;
        fn CTFontCopyAttribute(font: CFTypeRef, attribute: CFTypeRef) -> CFTypeRef;
        static kCTFontURLAttribute: CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLGetFileSystemRepresentation(
            url: CFTypeRef,
            resolve_against_base: u8,
            buffer: *mut u8,
            max_buf_len: CFIndex,
        ) -> u8;
    }

    /// Le fichier d'où CoreText tire réellement `font`.
    unsafe fn file_of(font: CFTypeRef) -> PathBuf {
        use std::os::unix::ffi::OsStrExt;
        let url = CFOwned::new(CTFontCopyAttribute(font, kCTFontURLAttribute)).expect("URL");
        let mut buf = [0u8; 1024];
        let ok = CFURLGetFileSystemRepresentation(url.get(), 1, buf.as_mut_ptr(), 1024);
        assert_ne!(ok, 0, "CFURLGetFileSystemRepresentation");
        let len = buf.iter().position(|b| *b == 0).unwrap();
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..len]));
        std::fs::canonicalize(&path).unwrap_or(path)
    }

    /// Chaque famille embarquée est dessinée depuis SON fichier, même quand une police du
    /// même nom est disponible par ailleurs. La collision est fabriquée : des copies de nos
    /// fichiers, enregistrées pour le processus AVANT, portent exactement les mêmes noms.
    /// Seul le chemin du fichier distingue le gagnant ; famille et graisse n'y suffisent pas.
    #[test]
    fn every_shipped_family_draws_from_its_own_files() {
        use std::os::unix::ffi::OsStrExt;
        let repo = std::fs::canonicalize(crate::text_fonts::repo_fonts_dir()).unwrap();
        let files = crate::text_fonts::font_files_in(&repo);
        let elsewhere =
            std::env::temp_dir().join(format!("openscreen-sysfonts-{}", std::process::id()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        let raster = unsafe {
            for file in &files {
                let copy = elsewhere.join(file.file_name().unwrap());
                std::fs::copy(file, &copy).unwrap();
                let bytes = copy.as_os_str().as_bytes();
                let url = CFOwned::new(CFURLCreateFromFileSystemRepresentation(
                    std::ptr::null(),
                    bytes.as_ptr(),
                    bytes.len() as CFIndex,
                    0,
                ))
                .unwrap();
                // 1 = kCTFontManagerScopeProcess.
                CTFontManagerRegisterFontsForURL(url.get(), 1, std::ptr::null_mut());
            }
            TextRasterizer {
                faces: Box::leak(load_faces(&files).into_boxed_slice()),
                still: std::sync::Mutex::new(Vec::new()),
            }
        };

        for family in crate::text_fonts::SHIPPED_FAMILIES {
            for bold in [false, true] {
                let font = unsafe { raster.shipped_font(family, bold, 40.0) }
                    .unwrap_or_else(|| panic!("{family} (gras={bold}) non embarquée"));
                unsafe {
                    let name = CFOwned::new(CTFontCopyFamilyName(font.get())).unwrap();
                    assert_eq!(cf_string_text(name.get()), family);
                    let traits = CTFontGetSymbolicTraits(font.get());
                    assert_eq!(traits & K_CT_FONT_TRAIT_BOLD != 0, bold, "{family} : graisse");
                    let file = file_of(font.get());
                    let from = file.display();
                    assert!(file.starts_with(&repo), "{family} (gras={bold}) tirée de {from}");
                }
            }
        }

        // Et chaque famille se voit, à l'encre dessinée.
        let mut blocks = Vec::new();
        for family in crate::text_fonts::SHIPPED_FAMILIES {
            let mut s = spec("Hamburgefonstiv");
            s.font_family = family.into();
            s.font_size_px = 100.0;
            s.box_px = [1600, 200];
            let Some((px, w, h)) = raster_bgra_with(&raster, &s) else {
                return;
            };
            let (x0, y0, x1, y1) = ink_bounds(&px, w, h);
            blocks.push((family, (x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32));
        }
        crate::text_fonts::assert_distinct_blocks(&blocks);
    }

    /// Le texte n'est pas retourné. Le test regarde où est l'encre plutôt que de faire
    /// confiance au sens du CTM : c'est la seule façon de distinguer « bien orienté » de
    /// « retourné », et le retournement était un vrai bug de ce fichier.
    ///
    /// Il compare les deux moitiés de la boîte ENGLOBANTE, pas de la boîte de sortie :
    /// depuis le centrage vertical, un texte bien orienté n'est plus majoritairement dans
    /// la moitié haute de la texture. `H` sur la première ligne et `.` sur la seconde rend
    /// le bloc très dissymétrique, donc le miroir se voit immédiatement.
    #[test]
    fn text_is_not_mirrored_vertically() {
        let Some((px, w, h)) = raster_bgra(&spec("HHHH\n.")) else {
            return;
        };
        let (_, y0, _, y1) = ink_bounds(&px, w, h);
        let ink = |rows: std::ops::Range<usize>| -> u64 {
            rows.map(|y| (0..w).map(|x| px[(y * w + x) * 4 + 3] as u64).sum::<u64>())
                .sum()
        };
        let mid = (y0 + y1) / 2;
        let (upper, lower) = (ink(y0..mid), ink(mid..y1 + 1));
        assert!(
            upper > lower * 3,
            "texte retourné : encre haut={upper}, bas={lower} (les `HHHH` sont sur la 1re ligne)"
        );
    }

    /// Le bug rapporté : une ligne de sous-titre se collait en haut de sa bande et laissait
    /// ~180 px de vide en dessous. La bande fait 22 % de la hauteur de l'image, donc la
    /// boîte est toujours bien plus haute que le texte — le bloc doit y être centré.
    ///
    /// La mesure porte sur la PLAQUE, pas sur les glyphes : l'encre ne remplit jamais sa
    /// hauteur de ligne (au-dessus des capitales et sous les jambages il reste du vide,
    /// en quantités inégales), donc ses marges ne sont pas symétriques même parfaitement
    /// centrées. La plaque, elle, est le bloc mis en page.
    #[test]
    fn a_single_line_is_centred_in_a_tall_box() {
        let mut s = spec("Bonjour tout le monde");
        s.background = [0.0, 0.0, 0.0, 1.0];
        // Une vraie bande de sous-titres en 1080p : 80 % de large, 22 % de haut.
        s.box_px = [1536, 238];
        let Some((px, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (x0, y0, x1, y1) = ink_bounds(&px, w, h);
        let (top, bottom) = (y0 as i64, (h - 1 - y1) as i64);
        let (left, right) = (x0 as i64, (w - 1 - x1) as i64);
        assert!(
            (top - bottom).abs() <= 1,
            "bloc non centré verticalement : {top} px au-dessus, {bottom} px en dessous"
        );
        assert!(
            (left - right).abs() <= 1,
            "bloc non centré horizontalement : {left} px à gauche, {right} px à droite"
        );
        // Et le vide restant est réparti, pas empilé en bas comme avant le correctif.
        assert!(top > 20, "la boîte fait {h} px de haut : le bloc devrait flotter dedans");
    }

    /// La plaque de fond épouse le bloc de texte au lieu de remplir la boîte. Sans ça, une
    /// bande de sous-titres est un pavé opaque de 22 % de la hauteur de l'image.
    #[test]
    fn the_background_plate_hugs_the_text_not_the_box() {
        let mut s = spec("Bonjour");
        s.background = [0.0, 0.0, 0.0, 1.0];
        s.box_px = [1536, 238];
        let Some((px, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (x0, y0, x1, y1) = ink_bounds(&px, w, h);
        let (plate_w, plate_h) = (x1 - x0 + 1, y1 - y0 + 1);
        assert!(
            plate_h < h / 2,
            "la plaque couvre {plate_h} px sur {h} : elle remplit encore la boîte"
        );
        assert!(
            plate_w < w / 2,
            "la plaque couvre {plate_w} px sur {w} : elle remplit encore la boîte"
        );
        // Le fond est opaque : les coins de la boîte doivent rester vides.
        for (cx, cy) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
            assert_eq!(
                px[(cy * w + cx) * 4 + 3],
                0,
                "coin ({cx}, {cy}) peint : la plaque déborde du bloc"
            );
        }
    }

    /// La plaque laisse respirer le texte : `0.1em` en haut/bas, `0.2em` à gauche/droite,
    /// le modèle de boîte partagé avec l'overlay DOM et le renderer canvas.
    #[test]
    fn the_plate_keeps_a_margin_around_the_glyphs() {
        let mut s = spec("Bonjour");
        s.box_px = [1536, 238];
        let Some((glyphs, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (gx0, _, gx1, _) = ink_bounds(&glyphs, w, h);

        s.background = [0.0, 0.0, 0.0, 1.0];
        let Some((plate, _, _)) = raster_bgra(&s) else {
            return;
        };
        let (px0, _, px1, _) = ink_bounds(&plate, w, h);

        assert!(
            px0 < gx0 && px1 > gx1,
            "la plaque ({px0}..{px1}) ne dépasse pas les glyphes ({gx0}..{gx1})"
        );
    }

    /// Un texte plus haut que sa boîte se coupe en BAS. Le centrer puis le rogner des deux
    /// côtés mangerait la première ligne, qui est celle qu'on veut lire.
    #[test]
    fn an_overflowing_text_starts_at_the_top() {
        let mut s = spec("Un texte tres long qui deborde largement de la boite prevue pour lui");
        s.box_px = [240, 90];
        let Some((px, w, h)) = raster_bgra(&s) else {
            return;
        };
        let (_, y0, _, _) = ink_bounds(&px, w, h);
        assert!(
            y0 < h / 4,
            "le débordement ne part pas du haut : première ligne d'encre à y={y0} sur {h}"
        );
    }

    /// Géométrie pure — pas de GPU, pas de CoreText.
    #[test]
    fn block_layout_centres_the_frame_and_sizes_the_plate() {
        let (frame, plate) = block_layout(1536.0, 238.0, 500.0, 56.0, 2, "center", true, 48.0);
        // Cadre centré : autant de vide au-dessus qu'en dessous (repère CG, y vers le haut).
        let above = 238.0 - (frame.origin.y + frame.size.height);
        let below = frame.origin.y;
        assert!((above - below).abs() <= 1.5, "cadre décentré : {above} / {below}");
        // Plaque = bloc + 0.2em/0.1em, centrée elle aussi.
        assert!((plate.size.width - (500.0 + 2.0 * 9.6)).abs() < 0.01);
        assert!((plate.size.height - (56.0 + 2.0 * 4.8)).abs() < 0.01);
        assert!((plate.origin.x - (1536.0 - plate.size.width) * 0.5).abs() < 0.01);
    }

    #[test]
    fn block_layout_never_lets_the_plate_leave_the_box() {
        for align in [0u8, 1, 2] {
            // Bloc plus large et plus haut que la boîte : la plaque doit se contenter d'elle.
            let (_, plate) = block_layout(200.0, 60.0, 400.0, 200.0, align, "center", true, 48.0);
            assert!(plate.origin.x >= 0.0, "align={align} : x={}", plate.origin.x);
            assert!(plate.origin.y >= 0.0, "align={align} : y={}", plate.origin.y);
            assert!(plate.origin.x + plate.size.width <= 200.0 + 0.01, "align={align}");
            assert!(plate.origin.y + plate.size.height <= 60.0 + 0.01, "align={align}");
        }
    }

    /// L'invariant de la refonte du placement des sous-titres, en géométrie pure.
    /// Un bloc centré voit ses DEUX arêtes bouger quand il grandit ; ancré, l'arête
    /// ancrée ne bouge pas. Repère CoreGraphics : `y` monte.
    #[test]
    fn block_layout_pins_the_anchored_edge_whatever_the_block_height() {
        let (box_w, box_h) = (1536.0, 238.0);
        let edges = |valign: &str, text_h: f64| {
            let (frame, _) = block_layout(box_w, box_h, 500.0, text_h, 2, valign, true, 48.0);
            // (bas, haut) en distance depuis le bas de la boîte.
            (frame.origin.y, frame.origin.y + frame.size.height)
        };

        // Ancrage bas : l'arête basse est la même à une et à trois lignes.
        let (one_bottom, _) = edges("bottom", 56.0);
        let (three_bottom, _) = edges("bottom", 168.0);
        assert!(
            (one_bottom - three_bottom).abs() < 0.01,
            "ancrage bas : l'arête basse a bougé de {one_bottom} à {three_bottom}"
        );

        // Ancrage haut : l'arête haute est la même.
        let (_, one_top) = edges("top", 56.0);
        let (_, three_top) = edges("top", 168.0);
        assert!(
            (one_top - three_top).abs() < 0.01,
            "ancrage haut : l'arête haute a bougé de {one_top} à {three_top}"
        );

        // Et le centrage, lui, fait bien bouger les deux — c'est le comportement
        // historique qu'on préserve pour les annotations.
        let (c1_bottom, c1_top) = edges("center", 56.0);
        let (c3_bottom, c3_top) = edges("center", 168.0);
        assert!(
            (c1_bottom - c3_bottom).abs() > 1.0 && (c1_top - c3_top).abs() > 1.0,
            "le centrage devrait déplacer les deux arêtes"
        );
    }

    /// Une lumière et un plasma : des pixels au-delà de la boîte, un texte qui bouge d'une image à
    /// l'autre, et le même texte à nouveau identique à la même heure, malgré ce qui est gardé.
    #[test]
    fn light_reaches_past_the_box_and_moving_text_stays_true_to_its_time() {
        let raster = TextRasterizer::new().unwrap();
        let mut s = spec("AB");
        s.box_px = [110, 110];
        s.fx = Some(TextFx {
            fill: Some(FillSpec {
                kind: "plasma".into(),
                palettes: vec![vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]],
                scale: 1.0,
                ..Default::default()
            }),
            glow: Some(text_fx::GlowSpec { colors: vec![[0.0, 1.0, 0.0]], em: 0.5, strength: 1.0, night: 0.0 }),
            ..Default::default()
        });
        let margin = s.margin_px() as usize;
        assert!(margin > 0);
        s.set_time(1000.0, 500.0);
        let Some((a, w, _)) = raster_bgra_with(&raster, &s) else { return };
        // Juste après le bord de la boîte.
        let side = w - margin + 2;
        let brightest = a.chunks_exact(4).skip(side).step_by(w).map(|p| p[1]).max().unwrap_or(0);
        assert!(brightest > 0, "pas de lumière hors de la boîte");
        let mut later = s.clone();
        later.set_time(1000.0, 1500.0);
        let (b, _, _) = raster_bgra_with(&raster, &later).unwrap();
        assert_ne!(a, b, "le plasma ne bouge pas");
        let (again, _, _) = raster_bgra_with(&raster, &s).unwrap();
        assert_eq!(a, again, "ce qui est gardé a changé les pixels");
    }

    /// Une couleur d'emoji ignore les masques : ce texte reste sur le chemin de toujours.
    #[test]
    fn text_with_an_emoji_draws_plain() {
        let mut s = spec("AB \u{1F525}");
        s.fx = Some(TextFx { bevel: 1.0, ..Default::default() });
        assert!(!s.wants_fx());
        assert_eq!(s.margin_px(), 0);
    }

    /// Dessine les looks d'un fichier JSON en BGRA brut, pour les regarder sur une vraie image.
    /// `FX_LOOKS=looks.json FX_OUT=dossier cargo test --lib fx_look_sheet -- --ignored`
    #[test]
    #[ignore]
    fn fx_look_sheet() {
        let looks: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(std::env::var("FX_LOOKS").unwrap()).unwrap())
                .unwrap();
        let out = std::env::var("FX_OUT").unwrap();
        let raster = TextRasterizer::new().unwrap();
        for look in looks {
            let name = look["name"].as_str().unwrap();
            let text: crate::scene::SceneAnnotationText =
                serde_json::from_value(look["text"].clone()).unwrap();
            let box_px = [look["w"].as_u64().unwrap() as u32, look["h"].as_u64().unwrap() as u32];
            let mut s = crate::compositor_macos::text_spec_of(&text, look["px"].as_f64().unwrap() as f32, box_px);
            s.set_time(look["elapsed"].as_f64().unwrap_or(1000.0) as f32, look["scene"].as_f64().unwrap_or(0.0) as f32);
            let started = std::time::Instant::now();
            let (px, _, _) = raster_bgra_with(&raster, &s).unwrap();
            eprintln!("{name}: {} ms", started.elapsed().as_millis());
            std::fs::write(format!("{out}/{name}.bgra"), px).unwrap();
            std::fs::write(format!("{out}/{name}.margin"), s.margin_px().to_string()).unwrap();
        }
    }
}