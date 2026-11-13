# Systems coverage

Control Center systems are native. Each implemented system speaks the manufacturer's published protocol. Companion module names are a checklist, so a later run can see what is still open. They are not loaded or wrapped.

Companion connection types: **1098**. Implemented: **82**. Partial: **0**. Not yet: **1016**.

## Systems in this build

| System | Status | Buttons | Variables | Feedbacks | Protocol basis | Source |
|---|---|---:|---:|---:|---|---|
| Analog Way Aquilon RS6 (`rs6`) | implemented | 3 | 3 | 3 | official | https://www.analogway.com/americas/products/aquilon-rs6/ |
| Barco Event Master (`e2`) | implemented | 3 | 4 | 3 | official | https://www.barco.com/en/support |
| PixelHue (`pixelhue`) | implemented | 3 | 4 | 3 | official | https://www.pixelhue.com/ |
| Blackmagic ATEM (`atem`) | implemented | 32 | 5 | 4 | official | https://www.blackmagicdesign.com/developer |
| Panasonic PTZ (`ptz`) | implemented | 111 | 6 | 3 | official | https://eww.pass.panasonic.co.jp/pro-av/support/content/guide/DEF/AW-UE150/HD/HD_OperationManual_English.pdf |
| AV Stumpfl Pixera (`pixera`) | implemented | 8 | 4 | 3 | official | https://help.pixera.one/api/ |
| Millumin (`millumin`) | implemented | 13 | 3 | 2 | official | https://www.millumin.com/documentation/ |
| Blackmagic Videohub (`videohub`) | implemented | 1 | 4 | 2 | official | https://documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf |
| Blackmagic HyperDeck (`hyperdeck`) | implemented | 9 | 5 | 3 | official | https://documents.blackmagicdesign.com/DeveloperManuals/HyperDeckEthernetProtocol.pdf |
| Mitti (`mitti`) | implemented | 8 | 3 | 3 | official | https://imimot.com/mitti/ |
| TSL tally (`tsl`) | implemented | 2 | 3 | 2 | official | https://tslproducts.com/ |
| Scopes (`scopes`) | implemented | 2 | 2 | 1 | official | https://www.blackmagicdesign.com/developer |
| Control Center (`console`) | implemented | 21 | 4 | 3 | official | — |
| Generic HTTP (`generic-http`) | implemented | 1 | 4 | 2 | official | https://www.rfc-editor.org/rfc/rfc9110 |
| Generic UDP (`generic-udp`) | implemented | 1 | 3 | 2 | official | https://www.rfc-editor.org/rfc/rfc768 |
| Generic TCP (`generic-tcp`) | implemented | 1 | 3 | 2 | official | https://www.rfc-editor.org/rfc/rfc9293 |
| vMix (`vmix`) | implemented | 19 | 7 | 6 | official | https://docs.vmix.com/help29/DeveloperAPI.html |
| OBS Studio (`obs`) | implemented | 9 | 5 | 4 | official | https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md |
| RossTalk (`ross-rosstalk`) | implemented | 9 | 2 | 1 | official | https://documentation.rossvideo.com/files/Manuals/Protocol%20Documents/RossTalk-Commands(4802DR-403).pdf |
| Sony VISCA (`sony-visca`) | implemented | 16 | 3 | 2 | official | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| BirdDog PTZ (`birddog-ptz`) | implemented | 12 | 2 | 2 | official | https://birddog.tv/ |
| QLab (`qlab`) | implemented | 9 | 3 | 2 | official | https://qlab.app/docs/v5/scripting/osc-dictionary/ |
| Resolume Arena (`resolume`) | implemented | 6 | 3 | 2 | official | https://resolume.com/support/en/osc |
| ProPresenter (`propresenter`) | implemented | 4 | 3 | 2 | official | https://openapi.propresenter.com/ |
| ETC Eos (`etc-eos`) | implemented | 5 | 2 | 2 | official | https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/ShowControl/OSC/OSC_Intro.htm |
| grandMA2 (`grandma2`) | implemented | 5 | 2 | 1 | official | https://help.malighting.com/Page/grandMA2/remote_command/en/3.9 |
| grandMA3 (`grandma3`) | implemented | 6 | 7 | 3 | official | https://help.malighting.com/grandMA3/2.5/HTML/osc_advanced_examples.html |
| Yamaha CL/QL (`yamaha-rcp`) | implemented | 5 | 2 | 1 | official | https://download.yamaha.com/files/tcm:39-1251310 |
| Allen & Heath SQ (`allenheath-sq`) | implemented | 4 | 2 | 1 | official | https://www.allen-heath.com/content/uploads/2023/11/SQ-MIDI-Protocol-Issue5.pdf |
| DiGiCo OSC (`digico`) | implemented | 3 | 2 | 1 | official | https://digico.biz/digico-opens-up-the-sd-range-with-generic-osc-control/ |
| Christie / PJLink (`christie-projector`) | implemented | 5 | 3 | 2 | official | https://pjlink.jbmia.or.jp/english/data_cl2.html |
| Barco Pulse (`barco-projector`) | implemented | 5 | 5 | 3 | official | https://www.barco.com/manuals/R5916611/w1p7s33hf4ko.html |
| CasparCG (`casparcg`) | implemented | 6 | 2 | 2 | official | https://github.com/CasparCG/help/wiki/AMCP-Protocol |
| NDI tools (`ndi`) | not yet | 0 | 1 | 1 | official | https://ndi.video/for-developers/ndi-sdk/ |
| AJA Ki Pro (`aja-kipro`) | implemented | 5 | 2 | 1 | official | https://www.aja.com/support/item/4184 |
| AJA KUMO (`aja-kumo`) | implemented | 2 | 3 | 1 | official | https://www.aja.com/support/item/9616 |
| Blackmagic SmartView (`bmd-smartview`) | implemented | 3 | 3 | 1 | official | https://documents.blackmagicdesign.com/UserManuals/SmartViewManual.pdf |
| Lightware LW3 (`lightware-lw3`) | implemented | 3 | 2 | 1 | official | https://www.lightware.com/en/support/open-api |
| Extron SIS matrix (`extron-sis`) | implemented | 5 | 2 | 1 | official | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| Kramer Protocol 3000 (`kramer-p3000`) | implemented | 2 | 2 | 1 | official | https://k.kramerav.com/downloads/protocols/protocol_3000_3.0_master_user.pdf |
| AJA HELO (`aja-helo`) | implemented | 7 | 2 | 1 | official | https://gitlab.aja.com/pub/rest_api/-/blob/master/HELO/03_HELO_Commands.md |
| Blackmagic Teranex (`bmd-teranex`) | implemented | 1 | 2 | 1 | official | https://documents.blackmagicdesign.com/UserManuals/TeranexManual.pdf |
| Blackmagic Streaming Encoder (`bmd-streaming`) | implemented | 4 | 2 | 1 | official | https://documents.blackmagicdesign.com/DeveloperManuals/WebPresenterEthernetProtocol.pdf |
| Lightware LW2 (`lightware-lw2`) | implemented | 4 | 2 | 1 | official | https://www.lightware.com/en/support/open-api |
| Kramer Protocol 2000 (`kramer-p2000`) | implemented | 3 | 1 | 1 | official | https://cdn.kramerav.com/web/downloads/manuals/protocol_2000_rev0_51.pdf |
| Ross XPression (`ross-xpression`) | implemented | 15 | 2 | 1 | official | https://documentation.rossvideo.com/files/Manuals/Protocol%20Documents/RossTalk-Commands(4802DR-403).pdf |
| Brompton Tessera (`brompton-tessera`) | implemented | 6 | 4 | 2 | official | https://dl.bromptontech.com/tessera/docs/TesseraIPControlAPI3_1_0_Beta4.pdf |
| NovaStar VX Pro (`novastar-vxpro`) | partial | 1 | 2 | 1 | official | https://device.report/manuals/novastar-vx2000-pro-control-protocol-v1 |
| Megapixel HELIOS (`helios`) | implemented | 6 | 3 | 2 | official | https://megapixelvr.com/downloads/HELIOS%20Processing%20System-User%20Guide.pdf |
| Behringer X32 (`behringer-x32`) | implemented | 4 | 3 | 2 | official | http://www.behringer.com/assets/X32_OSC_Remote_Protocol.pdf |
| Behringer X Air (`behringer-xair`) | implemented | 3 | 3 | 1 | official | https://www.manualshelf.com/manual/behringer/x18/air-series-osc-documentation-english.html |
| Allen & Heath dLive (`allenheath-dlive`) | implemented | 4 | 3 | 1 | official | https://www.allen-heath.com/content/uploads/2024/06/dLive-MIDI-Over-TCP-Protocol-V2.0.pdf |
| Behringer Wing (`behringer-wing`) | implemented | 3 | 3 | 1 | official | https://mediadl.musictribe.com/download/software/behringer/WING/WING%20Remote%20Protocols.pdf |
| Art-Net (`artnet`) | implemented | 1 | 3 | 1 | official | https://art-net.org.uk/how-it-works/streaming-packets/art-dmx-packet-definition/ |
| sACN (`sacn`) | implemented | 1 | 2 | 1 | official | https://tsp.esta.org/tsp/documents/published_docs.php |
| ChamSys MagicQ (`chamsys-magicq`) | implemented | 7 | 2 | 1 | official | https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/OSC.html |
| ChamSys QuickQ (`chamsys-quickq`) | implemented | 5 | 2 | 1 | official | https://docs.chamsys.co.uk/quickq/13.0/manual/touchosc.html |
| Panasonic AV-HS6000 (`panasonic-hs6000`) | implemented | 2 | 2 | 1 | official | https://eww.pass.panasonic.co.jp/pro-av/support/dload/hs6000_3ext/AV-HS6000%20external%20IF_protocol-E.pdf |
| Christie Spyder (`christie-spyder`) | implemented | 2 | 2 | 1 | official | https://www.christiedigital.com/globalassets/resources/public/spyder-s-api-commands-version-6.1.3.pdf |
| Barco PDS-4K (`barco-pds`) | implemented | 3 | 2 | 1 | official | https://www.fullcompass.com/common/files/83820-PDS4KUserGuide.pdf |
| Canon XC (`canon-xc`) | implemented | 2 | 2 | 1 | official | https://output.nl/u/images/canon-xc-control-protocol-specifications-005.pdf |
| Roland V-60HD (`roland-v60hd`) | implemented | 4 | 2 | 1 | official | https://static.roland.com/assets/media/pdf/V-60HD_reference_v31_eng04_W.pdf |
| Dataton WATCHOUT (`dataton-watchout`) | implemented | 5 | 2 | 1 | official | https://docs.dataton.com/guide/watchout/external-control/watchout-6-protocol.html |
| Analog Way Midra (`analogway-midra`) | not yet | 0 | 0 | 0 | official | https://www.analogway.com/downloads |
| Analog Way LiveCore (`analogway-livecore`) | not yet | 0 | 0 | 0 | official | https://www.analogway.com/downloads |
| Barco ImagePRO (`barco-imagepro`) | not yet | 0 | 0 | 0 | official | https://www.barco.com/en/support/docs/R5919184 |
| Ross NK router (`ross-nk`) | not yet | 0 | 0 | 0 | official | https://documentation.rossvideo.com/files/Manuals/Routers/NK/NK%20Series%20User%20Guide(9807DR-0100).pdf |

## Notes on sources

- Official means the command is the one the manufacturer's document names. The URL is that document, or the manufacturer page that publishes it.
- Yamaha CL/QL commands are the published remote-control lines (`set MIXER:Current/...`, `ssrecall_ex`). The command list ships in Yamaha's setup package. https://github.com/BrenekH/yamaha-rcp-docs/ is a public transcription of that list, not a second protocol.
- DiGiCo addresses are the console's own OSC paths. The Companion CSV is only a cross-reference.
- NDI routing is not implemented. The NDI SDK is a licensed binary and there is no open wire protocol in this build.
- grandMA3 control addresses are `/Page/Fader` and `/Page/Key`. Sequence feedback is the console's `/13.13.1.6.<n>` message (function, handle, percent).
- Barco Pulse is JSON-RPC 2.0 on TCP 9090 (`system.poweron`, `system.poweroff`, `optics.shutter.target`, `image.window.main.source`). Christie stays on PJLink.
- BirdDog uses the VISCA-over-IP command set its cameras document. Model-specific REST bodies are not guessed.
- ATEM's public interface is the Blackmagic SDK. The desk speaks that switcher protocol. The byte layout is the SDK's, not a separate REST document.
- Analog Way Midra and LiveCore have no buttons. The classic Midra programmer guide was not found on an Analog Way download, and LiveCore is not the LivePremier protocol already spoken by RS6.
- Barco ImagePRO-4K is listed on the Event Master protocol, which the E2 system already speaks. The older ImagePRO ASCII set is not aliased to PDS-4K.
- Ross NK third-party control is the NK-3RD serial protocols or the NK-SCP/A ASCII protocol. The user guide does not print a command line, so no button is sent.

## Every Companion connection

| Companion module | Status | Control Center system | Source |
|---|---|---|---|
| `1stpass-1stpass` | not yet | — | — |
| `7thsensedesign-delta` | not yet | — | — |
| `PosiStageNet-protocol` | not yet | — | — |
| `ablesign-digitalsignage` | not yet | — | — |
| `ableton-osc` | not yet | — | — |
| `adder-avm` | not yet | — | — |
| `adder-ccs-pro` | not yet | — | — |
| `adder-infinity-aim` | not yet | — | — |
| `adder-infinity-alif` | not yet | — | — |
| `adder-infinity100xseries` | not yet | — | — |
| `adder-xdip` | not yet | — | — |
| `adlerluiz-ytmdesktop` | not yet | — | — |
| `advatek-pixlite-mk3` | not yet | — | — |
| `aetaaudio-codecs` | not yet | — | — |
| `agf-characterworks` | not yet | — | — |
| `aimedia-encoder-captions` | not yet | — | — |
| `aimedia-icap` | not yet | — | — |
| `aimedia-lexilive` | not yet | — | — |
| `aimp-audioplayer` | not yet | — | — |
| `airtable-api` | not yet | — | — |
| `aja-bridge-live` | not yet | — | — |
| `aja-dante-12gam` | not yet | — | — |
| `aja-fs` | not yet | — | — |
| `aja-helo` | implemented | aja-helo | https://gitlab.aja.com/pub/rest_api/-/blob/master/HELO/03_HELO_Commands.md |
| `aja-kipro` | implemented | aja-kipro | https://www.aja.com/support/item/4184 |
| `aja-kumo` | implemented | aja-kumo | https://www.aja.com/support/item/9616 |
| `allenheath-ahm` | not yet | — | — |
| `allenheath-avantis` | not yet | — | — |
| `allenheath-cq` | not yet | — | — |
| `allenheath-dlive` | implemented | allenheath-dlive | https://www.allen-heath.com/content/uploads/2024/06/dLive-MIDI-Over-TCP-Protocol-V2.0.pdf |
| `allenheath-dlive-ilive` | not yet | — | — |
| `allenheath-dt168` | not yet | — | — |
| `allenheath-qu` | not yet | — | — |
| `allenheath-sq` | implemented | allenheath-sq | https://www.allen-heath.com/content/uploads/2023/11/SQ-MIDI-Protocol-Issue5.pdf |
| `alto-tmd16` | not yet | — | — |
| `amaran-desktop` | not yet | — | — |
| `analogway-awj` | implemented | rs6 | https://www.analogway.com/americas/products/aquilon-rs6/ |
| `analogway-coreplay` | not yet | — | — |
| `analogway-eks500` | not yet | — | — |
| `analogway-livecore` | not yet | analogway-livecore | https://www.analogway.com/downloads |
| `analogway-livecore-custom` | not yet | analogway-livecore | https://www.analogway.com/downloads |
| `analogway-livepremier` | implemented | rs6 | https://www.analogway.com/americas/products/aquilon-rs6/ |
| `analogway-midra` | not yet | analogway-midra | https://www.analogway.com/downloads |
| `analogway-picturall` | not yet | — | — |
| `analogway-pls300` | not yet | — | — |
| `analogway-vertige` | not yet | — | — |
| `analogway-vio` | not yet | — | — |
| `android-tv` | not yet | — | — |
| `anomes-millumin` | implemented | millumin | https://www.millumin.com/documentation/ |
| `apc-rackpdu` | not yet | — | — |
| `apc-ups` | not yet | — | — |
| `apple-tv` | not yet | — | — |
| `arkaos-mediamaster` | not yet | — | — |
| `arkona-bladerunner` | not yet | — | — |
| `arri-tally` | not yet | — | — |
| `astrastudio-onairscreen` | not yet | — | — |
| `aten-matrix` | not yet | — | — |
| `aten-pdu` | not yet | — | — |
| `atlasied-atmosphere` | not yet | — | — |
| `atlona-camera-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `atlona-clso` | not yet | — | — |
| `atlona-omega` | not yet | — | — |
| `attend2it-speakertimer` | not yet | — | — |
| `audac-mtx` | not yet | — | — |
| `audinate-dante-ddm` | not yet | — | — |
| `audinate-dantecontroller` | not yet | — | — |
| `audiostrom-liveprofessor` | not yet | — | — |
| `audiotechnica-ceilingarray` | not yet | — | — |
| `audiotechnica-digitalmixer` | not yet | — | — |
| `audiotechnica-discussionsystem` | not yet | — | — |
| `audiotechnica-esw` | not yet | — | — |
| `audiotechnica-system20` | not yet | — | — |
| `audivero-unityintercom-client` | not yet | — | — |
| `audivero-unityintercom-server` | not yet | — | — |
| `auri-tx2n` | not yet | — | — |
| `autodirector-mirusuite` | not yet | — | — |
| `auvicode-pixremote` | not yet | — | — |
| `aver-ptz` | not yet | — | — |
| `avgear-ip410` | not yet | — | — |
| `avgear-matrix` | not yet | — | — |
| `avishop-hdbaset-matrix` | not yet | — | — |
| `avitech-pacificms1plus` | not yet | — | — |
| `avitech-sequoia4k60-sequoia4k60l` | not yet | — | — |
| `avitech-titan-9000` | not yet | — | — |
| `avmatrix-shark` | not yet | — | — |
| `avmatrix-switcher` | not yet | — | — |
| `avmatrix-ts3019` | not yet | — | — |
| `avmediatools-protimer` | not yet | — | — |
| `avocet-landscape` | not yet | — | — |
| `avolites-ai` | not yet | — | — |
| `avolites-titan` | not yet | — | — |
| `avproconnect-acmx1616-auhd` | not yet | — | — |
| `avproedge-mxnet` | not yet | — | — |
| `avstumpfl-pixera` | implemented | pixera | https://help.pixera.one/api/ |
| `avstumpfl-wingsviosorx` | not yet | — | — |
| `aws-ec2` | not yet | — | — |
| `aws-elementallive` | not yet | — | — |
| `aws-medialive` | not yet | — | — |
| `axeltechnology-cgplus` | not yet | — | — |
| `axeltechnology-vjpro` | not yet | — | — |
| `axeltechnology-xplayout` | not yet | — | — |
| `axeltechnology-xradio` | not yet | — | — |
| `axeltechnology-youplay` | not yet | — | — |
| `axia-livewire-lwrp` | not yet | — | — |
| `aximmetry-composer` | not yet | — | — |
| `axis-ptz` | not yet | — | — |
| `badgermedia-trustabel` | not yet | — | — |
| `ballscore-broadcast` | not yet | — | — |
| `barco-clickshare` | not yet | — | — |
| `barco-dcs` | not yet | — | — |
| `barco-dp` | not yet | — | — |
| `barco-encore` | not yet | — | — |
| `barco-eventmaster` | implemented | e2 | https://www.barco.com/en/support |
| `barco-eventmaster-xml` | implemented | e2 | https://www.barco.com/en/support |
| `barco-hdx` | not yet | — | — |
| `barco-imagepro` | not yet | barco-imagepro | https://www.barco.com/en/support/docs/R5919184 |
| `barco-matrixpro` | not yet | — | — |
| `barco-pds` | implemented | barco-pds | https://www.fullcompass.com/common/files/83820-PDS4KUserGuide.pdf |
| `barco-pulse` | implemented | barco-projector | https://www.barco.com/manuals/R5916611/w1p7s33hf4ko.html |
| `base` | not yet | — | — |
| `baserow-baserow` | not yet | — | — |
| `baytto-q4` | not yet | — | — |
| `bbc-raven` | not yet | — | — |
| `beaware-conferencecaptioning` | not yet | — | — |
| `behringer-wing` | implemented | behringer-wing | https://mediadl.musictribe.com/download/software/behringer/WING/WING%20Remote%20Protocols.pdf |
| `behringer-x32` | implemented | behringer-x32 | http://www.behringer.com/assets/X32_OSC_Remote_Protocol.pdf |
| `behringer-xair` | implemented | behringer-xair | https://www.manualshelf.com/manual/behringer/x18/air-series-osc-documentation-english.html |
| `betr-support` | not yet | — | — |
| `biamp-audia` | not yet | — | — |
| `biamp-qtx` | not yet | — | — |
| `biamp-tesira` | not yet | — | — |
| `bigrig-tuneit` | not yet | — | — |
| `binary-moipcontroller` | not yet | — | — |
| `binwiederhier-ntfy` | not yet | — | — |
| `birddog-central` | not yet | — | — |
| `birddog-connect` | not yet | — | — |
| `birddog-converters` | not yet | — | — |
| `birddog-ptz` | implemented | birddog-ptz | https://birddog.tv/ |
| `bitfire-api` | not yet | — | — |
| `bitfocus-cloud` | not yet | — | — |
| `bitfocus-companion` | not yet | — | — |
| `bitfocus-snapshot` | not yet | — | — |
| `bitfocus-voice` | not yet | — | — |
| `bitfocusas-listener` | not yet | — | — |
| `blackbird-hdmimatrix` | not yet | — | — |
| `blackbox-boxilla` | not yet | — | — |
| `blackdiamondvideo-phantom800` | not yet | — | — |
| `bluebottle-leaguebroadcast` | not yet | — | — |
| `blustream-acm200` | not yet | — | — |
| `blustream-hdmimatrix` | not yet | — | — |
| `bmd-atem` | implemented | atem | https://www.blackmagicdesign.com/developer |
| `bmd-audiomonitor` | not yet | — | — |
| `bmd-cameras` | not yet | — | — |
| `bmd-fairlight-live` | not yet | — | — |
| `bmd-gpi-and-tally-interface` | not yet | — | — |
| `bmd-hyperdeck` | implemented | hyperdeck | https://documents.blackmagicdesign.com/DeveloperManuals/HyperDeckEthernetProtocol.pdf |
| `bmd-multiview16` | not yet | — | — |
| `bmd-multiview4` | not yet | — | — |
| `bmd-smartview` | implemented | bmd-smartview | https://documents.blackmagicdesign.com/UserManuals/SmartViewManual.pdf |
| `bmd-teranex` | implemented | bmd-teranex | https://documents.blackmagicdesign.com/UserManuals/TeranexManual.pdf |
| `bmd-teranex-mini` | not yet | — | — |
| `bmd-ultimatte` | not yet | — | — |
| `bmd-videohub` | implemented | videohub | https://documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf |
| `bmd-videohub-controlpanel` | not yet | — | — |
| `bmd-webpresenter` | implemented | bmd-streaming | https://documents.blackmagicdesign.com/DeveloperManuals/WebPresenterEthernetProtocol.pdf |
| `boinx-mimolive` | not yet | — | — |
| `bolin-ptz` | not yet | — | — |
| `bom-api` | not yet | — | — |
| `borealis-vor` | not yet | — | — |
| `borealsystems-director` | not yet | — | — |
| `bosch-dicentis` | not yet | — | — |
| `bosch-hd-cameracontrol` | not yet | — | — |
| `boxcast-api` | not yet | — | — |
| `brainsalt-backstage` | not yet | — | — |
| `brainstorm-suite` | not yet | — | — |
| `breeze-overlay` | not yet | — | — |
| `brightlink-bl-8x8-hdbt-hd20` | not yet | — | — |
| `brightsign-player` | not yet | — | — |
| `broadcastapps-soundbyte` | not yet | — | — |
| `broadlink-remote` | not yet | — | — |
| `brompton-tessera` | implemented | brompton-tessera | https://dl.bromptontech.com/tessera/docs/TesseraIPControlAPI3_1_0_Beta4.pdf |
| `bss-soundweb` | not yet | — | — |
| `bytehive-playoutbee` | not yet | — | — |
| `c4-clock` | not yet | — | — |
| `cablematters-matrix` | not yet | — | — |
| `calrec-cscp` | not yet | — | — |
| `camstreamer-camstreamer` | not yet | — | — |
| `canon-controller` | not yet | — | — |
| `canon-ptz` | implemented | canon-xc | https://output.nl/u/images/canon-xc-control-protocol-specifications-005.pdf |
| `canon-xf` | not yet | — | — |
| `captionkit-api` | not yet | — | — |
| `capture-visualiser` | not yet | — | — |
| `carousel-signage` | not yet | — | — |
| `casparcg-server` | implemented | casparcg | https://github.com/CasparCG/help/wiki/AMCP-Protocol |
| `castr-api` | not yet | — | — |
| `cedar-dns8d` | not yet | — | — |
| `chamsys-magicq-osc` | implemented | chamsys-magicq | https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/OSC.html |
| `chamsys-magicq-udp` | not yet | — | — |
| `chamsys-quickq` | implemented | chamsys-quickq | https://docs.chamsys.co.uk/quickq/13.0/manual/touchosc.html |
| `chilibytes-pdfosc` | not yet | — | — |
| `christie-projector` | implemented | christie-projector | https://pjlink.jbmia.or.jp/english/data_cl2.html |
| `christie-spyder` | implemented | christie-spyder | https://www.christiedigital.com/globalassets/resources/public/spyder-s-api-commands-version-6.1.3.pdf |
| `christie-wd` | not yet | — | — |
| `chromaq-vista` | not yet | — | — |
| `churchapps-freeshow` | not yet | — | — |
| `churchtranslator-api` | not yet | — | — |
| `chyronhego-lyric` | not yet | — | — |
| `cidercollective-cider` | not yet | — | — |
| `cinegy-capture` | not yet | — | — |
| `cisco-cbs-350` | not yet | — | — |
| `cisco-cms` | not yet | — | — |
| `cisco-collaboration-endpoints` | not yet | — | — |
| `cisco-roomos` | not yet | — | — |
| `cisco-webex-prototype` | not yet | — | — |
| `classx-liveboard` | not yet | — | — |
| `classx-mixboard` | not yet | — | — |
| `clearcom-freespeakii` | not yet | — | — |
| `clearcom-rest` | not yet | — | — |
| `clearcom-station-ic` | not yet | — | — |
| `cleartouch-ippctrl` | not yet | — | — |
| `clockworks-viewer` | not yet | — | — |
| `cockos-reaper` | not yet | — | — |
| `coda-linus` | not yet | — | — |
| `codirect-codirect` | not yet | — | — |
| `colorlight-grandshow` | not yet | — | — |
| `colorlight-processor` | not yet | — | — |
| `combitech-vidblasterx` | not yet | — | — |
| `companion-satellite` | not yet | — | — |
| `connect-webcaster` | not yet | — | — |
| `cooclaprotocol-http` | not yet | — | — |
| `cortex-cast` | not yet | — | — |
| `cosmomedia-slidelizer` | not yet | — | — |
| `cosmostreamer-cosmostreamer` | not yet | — | — |
| `creativeland-capacitimer` | not yet | — | — |
| `creativeland-mediacontrolbridge` | not yet | — | — |
| `crestron-digitalmatrix` | not yet | — | — |
| `crestron-hd-mdnxm-4kz-e` | not yet | — | — |
| `crestron-nvx` | not yet | — | — |
| `crewlan-connect` | not yet | — | — |
| `crystal-scte` | not yet | — | — |
| `ctpsystems-dio8008r` | not yet | — | — |
| `cue-keypadcue-55` | not yet | — | — |
| `cuego-ws` | not yet | — | — |
| `cuemanager-cuesheetconnector` | not yet | — | — |
| `cuemark-cuemark` | not yet | — | — |
| `cuetime-stagedisplay` | not yet | — | — |
| `cuetone-cueplayer` | not yet | — | — |
| `cuevacontrol-relo-io8` | not yet | — | — |
| `cvmeventi-countdown` | not yet | — | — |
| `cyberpower-pdu` | not yet | — | — |
| `cyp-matrix` | not yet | — | — |
| `dahuasecurity-ptz` | not yet | — | — |
| `dalite-scb` | not yet | — | — |
| `dan-dugan-automixer` | not yet | — | — |
| `danielnoethen-butt` | not yet | — | — |
| `dashare-lanchat` | not yet | — | — |
| `dashare-multiplay` | not yet | — | — |
| `dashare-multiplay3` | not yet | — | — |
| `dashmaster-2k` | not yet | — | — |
| `datapath-fx4` | not yet | — | — |
| `dataprobe-iboot-pdu` | not yet | — | — |
| `dataton-watchout` | implemented | dataton-watchout | https://docs.dataton.com/guide/watchout/external-control/watchout-6-protocol.html |
| `dataton-watchout-json` | not yet | — | — |
| `datavideo-dvip` | not yet | — | — |
| `datavideo-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `dbaudiotechnik-amps` | not yet | — | — |
| `dbaudiotechnik-dsp` | not yet | — | — |
| `dcc-ex-commandstation` | not yet | — | — |
| `denchisoft-vtubestudio` | not yet | — | — |
| `denon-dn-500bd-mkii` | not yet | — | — |
| `denon-receiver` | not yet | — | — |
| `denon-recorder` | not yet | — | — |
| `depili-clock-8001` | not yet | — | — |
| `derhamproductions-presenteringest` | not yet | — | — |
| `devantech-ds` | not yet | — | — |
| `devcore-mixingstation` | not yet | — | — |
| `dexon-dimax` | not yet | — | — |
| `dexon-divip` | not yet | — | — |
| `dexon-matrix` | not yet | — | — |
| `dhdaudio-control-api` | not yet | — | — |
| `dhdaudio-ecp` | not yet | — | — |
| `digico-osc` | implemented | digico | https://digico.biz/digico-opens-up-the-sd-range-with-generic-osc-control/ |
| `digital-projection` | not yet | — | — |
| `digitalloggers-powercontroller` | not yet | — | — |
| `digitalprojection-highlight` | not yet | — | — |
| `digitalprojection-projectors` | not yet | — | — |
| `directout-audioprocessors` | not yet | — | — |
| `discord-api` | not yet | — | — |
| `disguise-liveupdate` | not yet | — | — |
| `disguise-mtc` | not yet | — | — |
| `disguise-osc` | not yet | — | — |
| `disguise-session` | not yet | — | — |
| `disguise-smc` | not yet | — | — |
| `disguise-track-notes` | not yet | — | — |
| `djsoft-radioboss` | not yet | — | — |
| `dmxcontrolprojects-dmxcontrol3` | not yet | — | — |
| `dmxcore-dmxcore100` | not yet | — | — |
| `dolby-cinemaprocessor` | not yet | — | — |
| `dpa-wireless` | not yet | — | — |
| `draco-tera` | not yet | — | — |
| `dreamchip-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `dreamsolutions-lightfactory` | not yet | — | — |
| `dsan-limitimer` | not yet | — | — |
| `dsan-perfectcue` | not yet | — | — |
| `dtvideolabs-playbackproplus` | not yet | — | — |
| `duonn-atrium20` | not yet | — | — |
| `dylanmaudio-apps` | not yet | — | — |
| `easyprompter-remote` | not yet | — | — |
| `easyrecord-cgcontrol` | not yet | — | — |
| `eaton-epdu` | not yet | — | — |
| `ecamm-live` | not yet | — | — |
| `ecclesialab-worshiplive` | not yet | — | — |
| `eidsystems-kaleoai` | not yet | — | — |
| `eiki-wspprojector` | not yet | — | — |
| `elgato-keylight` | not yet | — | — |
| `emotimo-st4` | not yet | — | — |
| `epiphan-pearl` | not yet | — | — |
| `epson-businesspj` | not yet | — | — |
| `equipson-lightshark` | not yet | — | — |
| `ereca-stageracer` | not yet | — | — |
| `esphome-api` | not yet | — | — |
| `etc-echo` | not yet | — | — |
| `etc-eos` | implemented | etc-eos | https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/ShowControl/OSC/OSC_Intro.htm |
| `etc-paradigm` | not yet | — | — |
| `etcaudiovisuel-onlyview` | not yet | — | — |
| `etl-rfmatrix` | not yet | — | — |
| `eventapps-cueplayer` | not yet | — | — |
| `eventapps-screenfreeze` | not yet | — | — |
| `eventapps-timer` | not yet | — | — |
| `eventinteractions-live` | not yet | — | — |
| `eventspro-toolspro-timer` | not yet | — | — |
| `eventsync-server` | not yet | — | — |
| `evertz-dreamcatcher` | not yet | — | — |
| `evertz-quartz` | not yet | — | — |
| `evertz-symphony` | not yet | — | — |
| `evertz-vipx` | not yet | — | — |
| `evision-hd102` | not yet | — | — |
| `exertis-daisynet` | not yet | — | — |
| `extron-dxp` | implemented | extron-sis | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| `extron-dxp-hd-4k-plus` | implemented | extron-sis | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| `extron-in1604` | not yet | — | — |
| `extron-ipl-t-pcs4` | not yet | — | — |
| `extron-ipl250` | not yet | — | — |
| `extron-matrix` | implemented | extron-sis | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| `extron-mmx-tcp` | implemented | extron-sis | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| `extron-smp111` | not yet | — | — |
| `extron-smp351` | not yet | — | — |
| `extron-smx` | implemented | extron-sis | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| `extron-xtp-3200` | implemented | extron-sis | https://media.extron.com/public/download/files/userman/68-2368-51_B.pdf |
| `eyevinn-intercom` | not yet | — | — |
| `ezcastpro-kvm` | not yet | — | — |
| `ezcoo-matrix` | not yet | — | — |
| `faithchapel-videoplayoutserver` | not yet | — | — |
| `fbcgulfport-1tap` | not yet | — | — |
| `fblab-bpm2osc` | not yet | — | — |
| `feelworld-l3-series` | not yet | — | — |
| `figure53-go-button` | not yet | — | — |
| `figure53-qlab` | implemented | qlab | https://qlab.app/docs/v5/scripting/osc-dictionary/ |
| `figure53-qlab-advance` | implemented | qlab | https://qlab.app/docs/v5/scripting/osc-dictionary/ |
| `figure53-qview` | not yet | — | — |
| `fivem-console` | not yet | — | — |
| `fiverecords-tallyccupro` | not yet | — | — |
| `flamingosoftware-toucantype` | not yet | — | — |
| `focusrite-clarett` | not yet | — | — |
| `focusrite-mp8r` | not yet | — | — |
| `folivora-btt` | not yet | — | — |
| `fomako-camera-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `foobar2000-foobar2000` | not yet | — | — |
| `fora-hvs` | not yet | — | — |
| `fora-mfr` | not yet | — | — |
| `fora-processors` | not yet | — | — |
| `foscam-ptz` | not yet | — | — |
| `fourkay-matrix` | not yet | — | — |
| `fritz-fritzbox` | not yet | — | — |
| `fulldomepro-server` | not yet | — | — |
| `fullyfactory-fullykiosk` | not yet | — | — |
| `fursyt12-notgt` | not yet | — | — |
| `gallery-virtualvtrpro` | not yet | — | — |
| `gammacontrol-gmaestro` | not yet | — | — |
| `gdsys-muxkvmswitch` | not yet | — | — |
| `gefen-dvimatrix` | not yet | — | — |
| `genelec-smart-ip` | not yet | — | — |
| `generic-aes70` | not yet | — | — |
| `generic-artnet` | implemented | artnet | https://art-net.org.uk/how-it-works/streaming-packets/art-dmx-packet-definition/ |
| `generic-blink` | not yet | — | — |
| `generic-bridge` | not yet | — | — |
| `generic-browsercontrol` | not yet | — | — |
| `generic-dataentry` | not yet | — | — |
| `generic-ember` | not yet | — | — |
| `generic-emberplus` | not yet | — | — |
| `generic-filereader` | not yet | — | — |
| `generic-filesystem` | not yet | — | — |
| `generic-http` | implemented | generic-http | https://www.rfc-editor.org/rfc/rfc9110 |
| `generic-ical` | not yet | — | — |
| `generic-midi` | not yet | — | — |
| `generic-modbus` | not yet | — | — |
| `generic-mqtt` | not yet | — | — |
| `generic-mysql` | not yet | — | — |
| `generic-onvif` | not yet | — | — |
| `generic-osc` | implemented | generic-udp | https://www.rfc-editor.org/rfc/rfc768 |
| `generic-ping` | not yet | — | — |
| `generic-pingandwake` | not yet | — | — |
| `generic-pjlink` | implemented | christie-projector | https://pjlink.jbmia.or.jp/english/data_cl2.html |
| `generic-ptpv2-client` | not yet | — | — |
| `generic-rss-client` | not yet | — | — |
| `generic-sacn` | implemented | sacn | https://tsp.esta.org/tsp/documents/published_docs.php |
| `generic-smtp` | not yet | — | — |
| `generic-snmp` | not yet | — | — |
| `generic-speedtest` | not yet | — | — |
| `generic-ssh` | not yet | — | — |
| `generic-stopwatch` | not yet | — | — |
| `generic-swp02` | not yet | — | — |
| `generic-swp08` | not yet | — | — |
| `generic-syslog-client` | not yet | — | — |
| `generic-tcp-serial` | implemented | generic-tcp | https://www.rfc-editor.org/rfc/rfc9293 |
| `generic-tcp-udp` | implemented | generic-tcp + generic-udp | — |
| `generic-timezone` | not yet | — | — |
| `generic-wakeonlan` | not yet | — | — |
| `generic-websocket` | not yet | — | — |
| `generic-webtable` | not yet | — | — |
| `getontime-ontime` | not yet | — | — |
| `glensound-divine` | not yet | — | — |
| `glensound-gtmmobile` | not yet | — | — |
| `glensound-minferno` | not yet | — | — |
| `globalaudiosolutions-rita` | not yet | — | — |
| `globalcache-itac-cc` | not yet | — | — |
| `globalcache-itac-ir` | not yet | — | — |
| `globalcache-itac-sl` | not yet | — | — |
| `glypheo-subtitle` | not yet | — | — |
| `gnuralnet-livetoair` | not yet | — | — |
| `goalake-switch` | not yet | — | — |
| `google-assistant-relay` | not yet | — | — |
| `google-nest` | not yet | — | — |
| `google-sheets` | not yet | — | — |
| `google-slidescontroller` | not yet | — | — |
| `govee-lights` | not yet | — | — |
| `grassvalley-amp` | not yet | — | — |
| `grassvalley-ampp` | not yet | — | — |
| `grassvalley-kaleido-solo` | not yet | — | — |
| `grassvalley-kframe` | not yet | — | — |
| `gravitycurrent-synesthesia` | not yet | — | — |
| `greengo-intercom` | not yet | — | — |
| `greenhippo-hippotizer` | not yet | — | — |
| `greenhippo-hippotizer-rest` | not yet | — | — |
| `groupme-webhooks` | not yet | — | — |
| `gudesystems-smartpdu` | not yet | — | — |
| `h2r-graphics` | not yet | — | — |
| `h2r-layouts` | not yet | — | — |
| `haivision-connectdvr` | not yet | — | — |
| `haivision-kbencoder` | not yet | — | — |
| `haivision-makito-x4-decoder` | not yet | — | — |
| `haivision-makito-x4-encoder` | not yet | — | — |
| `harrison-mixbus32c` | not yet | — | — |
| `hdkatov-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `hdtv-wolfpackgreen` | not yet | — | — |
| `highcriteria-lhs` | not yet | — | — |
| `highend-hog4` | not yet | — | — |
| `highpass-accompaniment` | not yet | — | — |
| `highpass-countdown` | not yet | — | — |
| `highpass-pptimer` | not yet | — | — |
| `highpass-upc` | not yet | — | — |
| `hive-beebox` | not yet | — | — |
| `holboxdesign-rio` | not yet | — | — |
| `hollyland-solidcom` | not yet | — | — |
| `hologfx-holographics` | not yet | — | — |
| `holophonix-processor` | not yet | — | — |
| `homeassistant-server` | not yet | — | — |
| `hoobs-api` | not yet | — | — |
| `hopla-powerstudio` | not yet | — | — |
| `hynamic-mediaserver` | not yet | — | — |
| `ibm-watson` | not yet | — | — |
| `iccms-sib` | not yet | — | — |
| `iconnectivity-interfaces` | not yet | — | — |
| `ictag-easyvideo` | not yet | — | — |
| `icue-nexus` | not yet | — | — |
| `idk-fdx` | not yet | — | — |
| `idk-msd` | not yet | — | — |
| `idk-ninjar` | not yet | — | — |
| `ifelseware-avkey` | not yet | — | — |
| `ifelseware-avplayback` | not yet | — | — |
| `iiyama-prolite` | not yet | — | — |
| `ikan-lyrapoe` | not yet | — | — |
| `imagine-lrc` | not yet | — | — |
| `imimot-mitti` | implemented | mitti | https://imimot.com/mitti/ |
| `influxdb-apiv2` | not yet | — | — |
| `innosonix-maxx` | not yet | — | — |
| `integ-jnior` | not yet | — | — |
| `intel-ipmi` | not yet | — | — |
| `intelix-matrix` | not yet | — | — |
| `interactivetechnologies-cueserver` | not yet | — | — |
| `internetclicker-internetclickerremote` | not yet | — | — |
| `interspace-cueether` | not yet | — | — |
| `interspace-globalcue-live` | not yet | — | — |
| `interspace-mastercuev7` | not yet | — | — |
| `iobroker-ws` | not yet | — | — |
| `ioversal-vertex` | not yet | — | — |
| `ipl-ocp` | not yet | — | — |
| `irisdown-countdowntimer` | not yet | — | — |
| `irisdown-remoteshowcontrol` | not yet | — | — |
| `itsblue-scstw` | not yet | — | — |
| `jetbrains-ides` | not yet | — | — |
| `jhlx-wirecast` | not yet | — | — |
| `josephadams-gamepadio` | not yet | — | — |
| `josephadams-ptzpilot` | not yet | — | — |
| `josephadams-scriptlauncher` | not yet | — | — |
| `joy-playdeck` | not yet | — | — |
| `jozeemedia-jcounter` | not yet | — | — |
| `jubilatesoftware-zionworx` | not yet | — | — |
| `julusian-test` | not yet | — | — |
| `justmacros-lua` | not yet | — | — |
| `jvc-camera` | not yet | — | — |
| `jvc-ptz` | not yet | — | — |
| `kenku-fm` | not yet | — | — |
| `kernels-powersequencer` | not yet | — | — |
| `kiloview-4kconverter` | not yet | — | — |
| `kiloview-cuber1` | not yet | — | — |
| `kiloview-cubex1` | not yet | — | — |
| `kiloview-decoder` | not yet | — | — |
| `kiloview-encoder` | not yet | — | — |
| `kiloview-mediagateway` | not yet | — | — |
| `kiloview-ndi` | not yet | ndi | https://ndi.video/for-developers/ndi-sdk/ |
| `kinetra-graphics` | not yet | — | — |
| `kissbox-gpio` | not yet | — | — |
| `kkt-visioncontrol` | not yet | — | — |
| `klang-app` | not yet | — | — |
| `klang-immersive` | not yet | — | — |
| `klvr-chargerpro` | not yet | — | — |
| `knowcore-checkin` | not yet | — | — |
| `knx-ip` | not yet | — | — |
| `kommander-t3` | not yet | — | — |
| `konftools-showplaypi` | not yet | — | — |
| `kramer-matrix` | implemented | kramer-p3000 | https://k.kramerav.com/downloads/protocols/protocol_3000_3.0_master_user.pdf |
| `kramer-vp727` | implemented | kramer-p2000 | https://cdn.kramerav.com/web/downloads/manuals/protocol_2000_rev0_51.pdf |
| `kramer-vp734` | not yet | — | — |
| `kramer-vp773a` | not yet | — | — |
| `kramer-vs41h` | implemented | kramer-p2000 | https://cdn.kramerav.com/web/downloads/manuals/protocol_2000_rev0_51.pdf |
| `kxwell-ptz` | not yet | — | — |
| `lacoustics-amplifiers` | not yet | — | — |
| `lanternbird-cuecapture` | not yet | — | — |
| `lawo-vpro8` | not yet | — | — |
| `lea-amplifier` | not yet | — | — |
| `leader-zen` | not yet | — | — |
| `leaderphabrix-lpx-qx` | not yet | — | — |
| `leadled-clockotron` | not yet | — | — |
| `leafcoders-titler` | not yet | — | — |
| `lectrosonics-aspen` | not yet | — | — |
| `leolabs-ableset` | not yet | — | — |
| `leonreucher-vstopowerpoint` | not yet | — | — |
| `lgtv-display` | not yet | — | — |
| `lgtv-prodisplay` | not yet | — | — |
| `libreoffice-impress` | not yet | — | — |
| `lightware-lw2` | implemented | lightware-lw2 | https://www.lightware.com/en/support/open-api |
| `lightware-lw3` | implemented | lightware-lw3 | https://www.lightware.com/en/support/open-api |
| `lilliput-monitor` | not yet | — | — |
| `limagiran-holyrics` | not yet | — | — |
| `liminalet-zoomosc` | not yet | — | — |
| `lindy-38359-matrix` | not yet | — | — |
| `linkbox-remote` | not yet | — | — |
| `livelogix-cadence` | not yet | — | — |
| `livemind-recorder` | not yet | — | — |
| `livemotion-livematrix` | not yet | — | — |
| `liveplay-liveplay` | not yet | — | — |
| `liveskills-hyperslowpro` | not yet | — | — |
| `liveskills-ptzdirector` | not yet | — | — |
| `livingasone-control` | not yet | — | — |
| `lofas-ndistudioclock` | not yet | — | — |
| `logos-proclaim` | not yet | — | — |
| `lost-cause-photographic-controlroom` | not yet | — | — |
| `ltn-schedule` | not yet | — | — |
| `lumens-mediaprocessor` | not yet | — | — |
| `lumens-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `luminex-gigacore` | not yet | — | — |
| `luminex-luminode` | not yet | — | — |
| `lutron-caseta` | not yet | — | — |
| `lyntec-rpc-breaker` | not yet | — | — |
| `mackie-dlzcreator` | not yet | — | — |
| `madrix-aura` | not yet | — | — |
| `magewell-director` | not yet | — | — |
| `magewell-proconvert-decoder` | not yet | — | — |
| `magewell-ultrastream` | not yet | — | — |
| `magichome-bulb` | not yet | — | — |
| `magicsoft-recorder` | not yet | — | — |
| `magnimage-fseries` | not yet | — | — |
| `magnimage-mig-ec` | not yet | — | — |
| `makeprox-glue` | not yet | — | — |
| `malighting-grandma2` | implemented | grandma2 | https://help.malighting.com/Page/grandMA2/remote_command/en/3.9 |
| `malighting-grandma3` | implemented | grandma3 | https://help.malighting.com/grandMA3/2.5/HTML/osc_advanced_examples.html |
| `malighting-msc` | not yet | — | — |
| `manhattanbeachstudios-streamgraphicspro` | not yet | — | — |
| `marshall-cv-minicam` | not yet | — | — |
| `marshall-ipcamera` | not yet | — | — |
| `marshall-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `massimo-callegari-qlcplus` | not yet | — | — |
| `matrox-conductip` | not yet | — | — |
| `matrox-monarch` | not yet | — | — |
| `mds-otobako-pro` | not yet | — | — |
| `media-player-classic` | not yet | — | — |
| `mediakind-rx1` | not yet | — | — |
| `mediashout-mediashout6` | not yet | — | — |
| `meld-studio` | not yet | — | — |
| `metus-ingest` | not yet | — | — |
| `metus-player` | not yet | — | — |
| `meyersound-galaxy` | not yet | — | — |
| `micassign-consolesync` | not yet | — | — |
| `micorp-gabin` | not yet | — | — |
| `microfilms-gpio` | not yet | — | — |
| `microsoft-teams` | not yet | — | — |
| `microsoft-vscode` | not yet | — | — |
| `middleatlantic-racklink` | not yet | — | — |
| `middleman-adit` | not yet | — | — |
| `middleman-breaktime` | not yet | — | — |
| `middleman-scte104proxy` | not yet | — | — |
| `middlethings-middlecontrol` | not yet | — | — |
| `midia-keyboardsplitter` | not yet | — | — |
| `mikrotik-routeros` | not yet | — | — |
| `miniontoby-midi-multicammixer` | not yet | — | — |
| `mix16-pro` | not yet | — | — |
| `mixtech-theatremix` | not yet | — | — |
| `modelighting-edin` | not yet | — | — |
| `modulopi-kinetic` | not yet | — | — |
| `modulopi-moduloplayer` | not yet | — | — |
| `monnit-sensors` | not yet | — | — |
| `monospace-lightkey` | not yet | — | — |
| `monteiro-cronosdown` | not yet | — | — |
| `monteiro-pptvideo` | not yet | — | — |
| `motu-avb` | not yet | — | — |
| `moxa-e2200series` | not yet | — | — |
| `moxa-iologik-e1200` | not yet | — | — |
| `mrmoco-mhc` | not yet | — | — |
| `msc-router` | not yet | — | — |
| `mt-viki-matrix` | not yet | — | — |
| `multicam-systems-rcp` | not yet | — | — |
| `multicamsystems-multicamsuite` | not yet | — | — |
| `mutedeck-mutedeck` | not yet | — | — |
| `muxlab-kvm` | not yet | — | — |
| `mvr-helios` | implemented | helios | https://megapixelvr.com/downloads/HELIOS%20Processing%20System-User%20Guide.pdf |
| `myapplause-control` | not yet | — | — |
| `nanoleaf-shapes` | not yet | — | — |
| `nec-display` | not yet | — | — |
| `nec-projectors` | not yet | — | — |
| `neodarque-stagetimer2` | not yet | — | — |
| `neol-epowerswitch` | not yet | — | — |
| `netgear-avline` | not yet | — | — |
| `netinsight-nimbraedge` | not yet | — | — |
| `netio-powerbox` | not yet | — | — |
| `netron-en` | not yet | — | — |
| `neumannmueller-stageflow` | not yet | — | — |
| `neutrik-dpro` | not yet | — | — |
| `nevion-mrp` | not yet | — | — |
| `nevion-np0017` | not yet | — | — |
| `nevion-videoipath` | not yet | — | — |
| `newblue-captivate` | not yet | — | — |
| `newbluefx-titler` | not yet | — | — |
| `neworange-encoder` | not yet | — | — |
| `newtek-ndistudiomonitor` | not yet | ndi | https://ndi.video/for-developers/ndi-sdk/ |
| `newtek-tricaster` | not yet | — | — |
| `nexo-nxamp` | not yet | — | — |
| `nextkon-screen` | not yet | — | — |
| `nextologies-nextotalk` | not yet | — | — |
| `ninja-timer` | not yet | — | — |
| `nobe-omniscope` | not yet | — | — |
| `noctavoxfilms-tallycomm` | not yet | — | — |
| `nohassleav-matrix` | not yet | — | — |
| `nohassleav-videowallprocessor` | not yet | — | — |
| `noiseproductions-virtualvideodirector` | not yet | — | — |
| `noiseproductions-vvd` | not yet | — | — |
| `noismada-octopuslistener` | not yet | — | — |
| `noismada-octopusshowcontrol` | not yet | — | — |
| `nortek-bluebolt` | not yet | — | — |
| `notion-timestamp` | not yet | — | — |
| `novastar-allinone` | not yet | — | — |
| `novastar-broadcastswitcher` | not yet | — | — |
| `novastar-coex` | not yet | — | — |
| `novastar-controller` | not yet | — | — |
| `novastar-d12` | not yet | — | — |
| `novastar-mediaserver` | not yet | — | — |
| `novastar-mxreal3` | not yet | — | — |
| `novastar-splicer` | not yet | — | — |
| `novastar-switcher` | not yet | — | — |
| `novastar-t-series` | not yet | — | — |
| `novastar-vx4s` | not yet | — | — |
| `nrk-sofie-chef` | not yet | — | — |
| `ntp-technology-dot` | not yet | — | — |
| `nws-api` | not yet | — | — |
| `obs-studio` | implemented | obs | https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md |
| `obsbot-osc` | not yet | — | — |
| `obsidiancontrol-onyx` | not yet | — | — |
| `obsidiancontrol-onyx-osc` | not yet | — | — |
| `octava-pro-dsx` | not yet | — | — |
| `octocue-clicker` | not yet | — | — |
| `odyssey-insight` | not yet | — | — |
| `olzzon-ndicontroller` | not yet | — | — |
| `oncue-oncue` | not yet | — | — |
| `openlp-http` | not yet | — | — |
| `openrgb-sdk` | not yet | — | — |
| `opensong-api` | not yet | — | — |
| `openweather-rest` | not yet | — | — |
| `opps-productiontimer` | not yet | — | — |
| `opticis-omm-1000` | not yet | — | — |
| `optimalaudio-zone` | not yet | — | — |
| `optisigns-digitalsignage` | not yet | — | — |
| `optoma-z28s` | not yet | — | — |
| `orei-matrix` | not yet | — | — |
| `orfast-ndi` | not yet | — | — |
| `oscidi-oscidi` | not yet | — | — |
| `osctimer-osctimer` | not yet | — | — |
| `osee-gostream-series` | not yet | — | — |
| `osmako-liveapppro` | not yet | — | — |
| `outline-et` | not yet | — | — |
| `outline-newton` | not yet | — | — |
| `overlaysuno-control` | not yet | — | — |
| `panasonic-ak-hrp1000` | not yet | — | — |
| `panasonic-atss` | not yet | — | — |
| `panasonic-av-hs6000` | implemented | panasonic-hs6000 | https://eww.pass.panasonic.co.jp/pro-av/support/dload/hs6000_3ext/AV-HS6000%20external%20IF_protocol-E.pdf |
| `panasonic-av-hsw10` | not yet | — | — |
| `panasonic-avhs` | not yet | — | — |
| `panasonic-camera-controller` | not yet | — | — |
| `panasonic-cameras` | not yet | — | — |
| `panasonic-kairos` | not yet | — | — |
| `panasonic-lumix` | not yet | — | — |
| `panasonic-mediaproductionsuite` | not yet | — | — |
| `panasonic-p2` | not yet | — | — |
| `panasonic-projector` | not yet | — | — |
| `panasonic-ptz` | implemented | ptz | https://eww.pass.panasonic.co.jp/pro-av/support/content/guide/DEF/AW-UE150/HD/HD_OperationManual_English.pdf |
| `panasonic-tv-th` | not yet | — | — |
| `pangolin-beyond` | not yet | — | — |
| `pastebin-api` | not yet | — | — |
| `pavonine-teleprompter` | not yet | — | — |
| `peavy-ratc` | not yet | — | — |
| `phabrix-qx` | not yet | — | — |
| `pharos-designer` | not yet | — | — |
| `philips-hue` | not yet | — | — |
| `philips-sicp` | not yet | — | — |
| `philips-wiz-bulbs` | not yet | — | — |
| `pideck-player` | not yet | — | — |
| `pikvm-kvmdapi` | not yet | — | — |
| `pixap-pixtimerpro` | not yet | — | — |
| `pixelhue-f-series` | not yet | — | — |
| `pixelhue-liveproductionswitcher` | implemented | pixelhue | https://www.pixelhue.com/ |
| `pixelhue-mediaserver` | not yet | — | — |
| `pixelhue-switcher` | implemented | pixelhue | https://www.pixelhue.com/ |
| `pixelmosaic-smartpreso` | not yet | — | — |
| `pixotope-gateway` | not yet | — | — |
| `pkinc-trucue` | not yet | — | — |
| `planningcenter-serviceslive` | not yet | — | — |
| `pltech-kumatimer` | not yet | — | — |
| `pnh-opencountdown` | not yet | — | — |
| `pnh-soundr` | not yet | — | — |
| `polecam-autopod` | not yet | — | — |
| `pomfort-livegradepro` | not yet | — | — |
| `powersoft-amplifiers` | not yet | — | — |
| `presentationtools-aps` | not yet | — | — |
| `presentationtools-cuetimer` | not yet | — | — |
| `prinsvision-server` | not yet | — | — |
| `prodigy-osc` | not yet | — | — |
| `prodlink-comms` | not yet | — | — |
| `prodlink-draw-on-slides` | not yet | — | — |
| `projetech-studio` | not yet | — | — |
| `protopie-bridge` | not yet | — | — |
| `proxicast-ezoutlet5` | not yet | — | — |
| `prsi-ipower` | not yet | — | — |
| `ptzoptics-superjoy` | not yet | — | — |
| `ptzoptics-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `pulseaudio-server` | not yet | — | — |
| `purelink-pt-ma-hd44m` | not yet | — | — |
| `puretools-matrix` | not yet | — | — |
| `pushover-api` | not yet | — | — |
| `pynch-nexa` | not yet | — | — |
| `qmsk-e2` | not yet | — | — |
| `qsys-remote-control` | not yet | — | — |
| `quicklink-studiopro` | not yet | — | — |
| `radiodj-rest` | not yet | — | — |
| `raspberry-gpio` | not yet | — | — |
| `rationalacoustics-smaart3` | not yet | — | — |
| `rationalacoustics-smaart4` | not yet | — | — |
| `red-rcp2` | not yet | — | — |
| `reddotlogics-hdmimatrix` | not yet | — | — |
| `renewedvision-propresenter` | implemented | propresenter | https://openapi.propresenter.com/ |
| `renewedvision-propresenter-api` | implemented | propresenter | https://openapi.propresenter.com/ |
| `renewedvision-pvp` | not yet | — | — |
| `repeatlast-repeatlast` | not yet | — | — |
| `requests` | not yet | — | — |
| `resi-decoders` | not yet | — | — |
| `resi-studio` | not yet | — | — |
| `resolume-arena` | implemented | resolume | https://resolume.com/support/en/osc |
| `restream-api` | not yet | — | — |
| `rgblink-mini` | not yet | — | — |
| `rgblink-tao1pro` | not yet | — | — |
| `rgblink-vsp628pro` | not yet | — | — |
| `rgblink-x3` | not yet | — | — |
| `riedel-medianetworks` | not yet | — | — |
| `riedel-mediornet` | not yet | — | — |
| `riedel-rrcs` | not yet | — | — |
| `riedel-smartpanel` | not yet | — | — |
| `riotgames-leagueoflegends` | not yet | — | — |
| `riotgames-replay` | not yet | — | — |
| `rm-tallylights` | not yet | — | — |
| `rme-totalmix` | not yet | — | — |
| `rocosoft-ptzjoy` | not yet | — | — |
| `rode-rcv` | not yet | — | — |
| `rogueamoeba-farrago` | not yet | — | — |
| `roku-tv` | not yet | — | — |
| `roland-m5000` | not yet | — | — |
| `roland-p20hd` | not yet | — | — |
| `roland-v1-4k` | not yet | — | — |
| `roland-v1200hd` | not yet | — | — |
| `roland-v160hd` | not yet | — | — |
| `roland-v600uhd` | not yet | — | — |
| `roland-v60hd` | implemented | roland-v60hd | https://static.roland.com/assets/media/pdf/V-60HD_reference_v31_eng04_W.pdf |
| `roland-v80hd` | not yet | — | — |
| `roland-vp42h` | not yet | — | — |
| `roland-vr120hd` | not yet | — | — |
| `roland-vr400uhd` | not yet | — | — |
| `roland-vr50hd-mk2` | not yet | — | — |
| `roland-xs42h` | not yet | — | — |
| `roland-xs62s` | not yet | — | — |
| `roland-xs84h` | not yet | — | — |
| `rossvideo-caprica` | not yet | — | — |
| `rossvideo-nkrouter` | not yet | ross-nk | https://documentation.rossvideo.com/files/Manuals/Routers/NK/NK%20Series%20User%20Guide(9807DR-0100).pdf |
| `rossvideo-rosstalk` | implemented | ross-rosstalk | https://documentation.rossvideo.com/files/Manuals/Protocol%20Documents/RossTalk-Commands(4802DR-403).pdf |
| `rossvideo-videoserver` | not yet | — | — |
| `rossvideo-xpression` | implemented | ross-xpression | https://documentation.rossvideo.com/files/Manuals/Protocol%20Documents/RossTalk-Commands(4802DR-403).pdf |
| `rtw-touchmonitor` | not yet | — | — |
| `rundown-studio` | not yet | — | — |
| `saccani-live-studio` | not yet | — | — |
| `sain-smart-relay` | not yet | — | — |
| `samsung-business-tv` | not yet | — | — |
| `samsung-display` | not yet | — | — |
| `samsung-led-vp` | not yet | — | — |
| `samsung-smarttv` | not yet | — | — |
| `samsung-tizenos` | not yet | — | — |
| `sanyo-projector` | not yet | — | — |
| `sardiusmedia-sardiuslive` | not yet | — | — |
| `screenbird-signage` | not yet | — | — |
| `screencloud-controller` | not yet | — | — |
| `seervision-suite` | not yet | — | — |
| `sennheiser-adn-mediactrl` | not yet | — | — |
| `sennheiser-digital6000` | not yet | — | — |
| `sennheiser-evolutionwireless` | not yet | — | — |
| `sennheiser-ewdx` | not yet | — | — |
| `sennheiser-spectera` | not yet | — | — |
| `sennheiser-teamconnect-ceiling` | not yet | — | — |
| `sevenpointtechnologies-7pointaudio` | not yet | — | — |
| `sgl-dct` | not yet | — | — |
| `sharp-tv` | not yet | — | — |
| `sharun-pdfpresenter` | not yet | — | — |
| `shelly-http` | not yet | — | — |
| `shelly-ws` | not yet | — | — |
| `showcuesystems-scs` | not yet | — | — |
| `showrevue-showrevue` | not yet | — | — |
| `showsign-signage` | not yet | — | — |
| `showtec-lampy` | not yet | — | — |
| `showtrak-server` | not yet | — | — |
| `shure-ani4in` | not yet | — | — |
| `shure-chargers` | not yet | — | — |
| `shure-dca901` | not yet | — | — |
| `shure-dis-ccu` | not yet | — | — |
| `shure-dsp` | not yet | — | — |
| `shure-mxa910` | not yet | — | — |
| `shure-mxcw` | not yet | — | — |
| `shure-mxn5` | not yet | — | — |
| `shure-mxw` | not yet | — | — |
| `shure-p300` | not yet | — | — |
| `shure-psm1000` | not yet | — | — |
| `shure-scm820` | not yet | — | — |
| `shure-wireless` | not yet | — | — |
| `sienna-ndimonitor` | not yet | — | — |
| `sikn-kerkomroep` | not yet | — | — |
| `simedia-yesapi` | not yet | — | — |
| `simonhyde-piclock` | not yet | — | — |
| `singularlive-studio` | not yet | — | — |
| `skaarhoj-rawpanel` | not yet | — | — |
| `slack-webhooks` | not yet | — | — |
| `slidecrew-slidecrew` | not yet | — | — |
| `smartavi-ipmatrix` | not yet | — | — |
| `smartpi-dva` | not yet | — | — |
| `smartpi-eye` | not yet | — | — |
| `smartptz-remotecontrol` | not yet | — | — |
| `smodetech-smodelive` | not yet | — | — |
| `smokotnin-opensoundmeter` | not yet | — | — |
| `snapav-wattbox` | not yet | — | — |
| `snellwilcox-kahuna` | not yet | — | — |
| `socialstream-ninja` | not yet | — | — |
| `softouch-easyworship` | not yet | — | — |
| `softron-movierecorder` | not yet | — | — |
| `softron-mreplay` | not yet | — | — |
| `softron-multicamlogger` | not yet | — | — |
| `softron-ontheaircg` | not yet | — | — |
| `softron-ontheairvideo` | not yet | — | — |
| `softvelum-nimble-streamer` | not yet | — | — |
| `softvelum-wmspanel` | not yet | — | — |
| `songbeamer-osc` | not yet | — | — |
| `sonifex-avn-m8r` | not yet | — | — |
| `sononum-horae` | not yet | — | — |
| `sonoran-coyote` | not yet | — | — |
| `sonos-speakers` | not yet | — | — |
| `sony-bravia` | not yet | — | — |
| `sony-bravia-simpleip` | not yet | — | — |
| `sony-broadcastmonitor` | not yet | — | — |
| `sony-cled` | not yet | — | — |
| `sony-ptz` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `sony-pxw` | not yet | — | — |
| `sony-serialtally` | not yet | — | — |
| `sony-srg-a12` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `sony-visca` | implemented | sony-visca | https://pro.sony/ue_US/support-resources/knowledge-base/manuals |
| `soonia-events` | not yet | — | — |
| `soundcraft-ui` | not yet | — | — |
| `sounddevices-pixnet` | not yet | — | — |
| `soundtrack-remote` | not yet | — | — |
| `spaceage-visibox` | not yet | — | — |
| `spacecommz-intercom` | not yet | — | — |
| `sportsmodule-rundown` | not yet | — | — |
| `spotify-remote` | not yet | — | — |
| `spx-graphics-controller` | not yet | — | — |
| `squared-powerlink` | not yet | — | — |
| `stageaudioworks-obs-multisite` | not yet | — | — |
| `stagepoint-rundown` | not yet | — | — |
| `stagetec-emberplus-avatus` | not yet | — | — |
| `stagetec-emberplus-generic` | not yet | — | — |
| `stagetec-emberplus-nxct` | not yet | — | — |
| `stagetec-nexus` | not yet | — | — |
| `stagetec-rcp` | not yet | — | — |
| `stagetec-xci` | not yet | — | — |
| `stagetimerio-api` | not yet | — | — |
| `storz-bickel-crafty` | not yet | — | — |
| `stramatel-slvideosystem` | not yet | — | — |
| `streamerbot-api` | not yet | — | — |
| `streamlabs-desktop` | not yet | — | — |
| `streamlingo-streamlingo` | not yet | — | — |
| `studiocoast-vmix` | implemented | vmix | https://docs.vmix.com/help29/DeveloperAPI.html |
| `studiotech-dante` | not yet | — | — |
| `stype-realline` | not yet | — | — |
| `svt-bridge` | not yet | — | — |
| `svt-neo` | not yet | — | — |
| `symetrix-dsp` | not yet | — | — |
| `synaccess-netbooter-bseries` | not yet | — | — |
| `syncer-live` | not yet | — | — |
| `syncthingfoundation-syncthing` | not yet | — | — |
| `synq-dbt44` | not yet | — | — |
| `tagvs-mcs` | not yet | — | — |
| `talkboardai-api` | not yet | — | — |
| `talktome-intercom` | not yet | — | — |
| `tallyma-wirelesstally` | not yet | — | — |
| `tascam-bdmp1` | not yet | — | — |
| `tascam-cd` | not yet | — | — |
| `tascam-cd400u` | not yet | — | — |
| `tascam-da-6400` | not yet | — | — |
| `tasmota-http` | not yet | — | — |
| `tasmota-mqtt` | not yet | — | — |
| `tcast-tcast` | not yet | — | — |
| `tchelicon-goxlr` | not yet | — | — |
| `teamspeak-v5` | not yet | — | — |
| `techministry-beacon` | not yet | — | — |
| `techministry-midirelay` | not yet | — | — |
| `techministry-protally` | not yet | — | — |
| `techministry-spotifycontroller` | not yet | — | — |
| `techministry-tallyarbiter` | not yet | — | — |
| `techministry-timekeeper` | not yet | — | — |
| `tecnopoint-tunings` | not yet | — | — |
| `telegram-bot` | not yet | — | — |
| `telestream-prism` | not yet | — | — |
| `telestream-wirecast` | not yet | — | — |
| `televic-confero` | not yet | — | — |
| `televic-dcerno` | not yet | — | — |
| `tellyo-streamstudio` | not yet | — | — |
| `telos-25-seven-program-delay-manager` | not yet | — | — |
| `telycam-ptz-ip-camera` | not yet | — | — |
| `template-es6` | not yet | — | — |
| `template-js` | not yet | — | — |
| `template-ts` | not yet | — | — |
| `tenveo-ptz` | not yet | — | — |
| `teracom-tcw181b` | not yet | — | — |
| `teradek-prism` | not yet | — | — |
| `teradek-vidiu` | not yet | — | — |
| `teradek-vidiux` | not yet | — | — |
| `tesla-smart` | not yet | — | — |
| `tesmart-hdmimatrix` | not yet | — | — |
| `testbildmedia-stgtime` | not yet | — | — |
| `textmebot-whatsappapi` | not yet | — | — |
| `theatrixx-xpresscue` | not yet | — | — |
| `thelightingcontroller` | not yet | — | — |
| `thenoteslist-thenoteslist` | not yet | — | — |
| `thingm-blink1` | not yet | — | — |
| `threesixty-nextcue` | not yet | — | — |
| `tieline-gateway` | not yet | — | — |
| `timemachines-clock` | not yet | — | — |
| `tinkerlist-cuez-automator` | not yet | — | — |
| `tlof-neoluma-midi-control` | not yet | — | — |
| `toggl-track` | not yet | — | — |
| `tools` | not yet | — | — |
| `toolsonair-justincapture` | not yet | — | — |
| `touchpoint-meetings` | not yet | — | — |
| `tow-mixeffect` | not yet | — | — |
| `tplink-kasasmartbulb` | not yet | — | — |
| `tplink-kasasmartdimmer` | not yet | — | — |
| `tplink-kasasmartplug` | not yet | — | — |
| `tplink-kasasmartstrip` | not yet | — | — |
| `tplink-taposmartplug` | not yet | — | — |
| `tractus-ndimv` | not yet | — | — |
| `tractus-ndirouter` | not yet | — | — |
| `trms-cablecast` | not yet | — | — |
| `trms-mediascribe` | not yet | — | — |
| `tslproducts-umd` | implemented | tsl | https://tslproducts.com/ |
| `tslproducts-umdlistener` | not yet | — | — |
| `tslproducts-usp3` | not yet | — | — |
| `turtleav-chazy-control` | not yet | — | — |
| `turtleav-mineola` | not yet | — | — |
| `tvone-calico` | not yet | — | — |
| `tvone-corio` | not yet | — | — |
| `twitch-api` | not yet | — | — |
| `twoloox-pandorasbox` | not yet | — | — |
| `ubiquiti-unifi` | not yet | — | — |
| `unifi-access` | not yet | — | — |
| `uniliga-cg` | not yet | — | — |
| `unwrittenmedia-slidecapture` | not yet | — | — |
| `usl-jsd` | not yet | — | — |
| `utahscientific-bpspanel` | not yet | — | — |
| `utopianacademy-deckboy` | not yet | — | — |
| `uts-remotevolume` | not yet | — | — |
| `vaddio-ptz` | not yet | — | — |
| `vbaudio-voicemeeter` | not yet | — | — |
| `vdo-ninja` | not yet | — | — |
| `vdwall-lvp615` | not yet | — | — |
| `ventuz-director` | not yet | — | — |
| `venucable-planner` | not yet | — | — |
| `vhd-vx61xl` | not yet | — | — |
| `vhd-vx90` | not yet | — | — |
| `vicreo-broadcast-titles` | not yet | — | — |
| `vicreo-colorboxcontrol` | not yet | — | — |
| `vicreo-display` | not yet | — | — |
| `vicreo-hotkey` | not yet | — | — |
| `vicreo-timer` | not yet | — | — |
| `vicreo-variablelistener` | not yet | — | — |
| `videobridgesolutions-vbs-overlay` | not yet | — | — |
| `videocom-zoom-bridge` | not yet | — | — |
| `videolan-vlc` | not yet | — | — |
| `videopathe-qmapper` | not yet | — | — |
| `videopathe-qmonitor` | not yet | — | — |
| `videopathe-qplayer` | not yet | — | — |
| `videopathe-qtimer` | not yet | — | — |
| `videopeople-podcastpilot` | not yet | — | — |
| `videotaxi-speech-events` | not yet | — | — |
| `videowalrus-hyperremote` | not yet | — | — |
| `videowalrus-simpleclock` | not yet | — | — |
| `vimeo-livestreamstudio6` | not yet | — | — |
| `vioso-exaplay` | not yet | — | — |
| `visionmill-nextnote` | not yet | — | — |
| `vislink-l2074` | not yet | — | — |
| `vislink-ulrx-ld` | not yet | — | — |
| `vistream-online` | not yet | — | — |
| `visualproductions-bstation2` | not yet | — | — |
| `visualproductions-cuety` | not yet | — | — |
| `visualproductions-iocore` | not yet | — | — |
| `visualproductions-timecore` | not yet | — | — |
| `vitec-avediaplayer9300-series` | not yet | — | — |
| `vivitek-projector` | not yet | — | — |
| `vizio-smartcast` | not yet | — | — |
| `vizrt-flowics` | not yet | — | — |
| `vizrt-mosart` | not yet | — | — |
| `vizrt-tcp-engine-trio` | not yet | — | — |
| `vkmedia-onairtimer` | not yet | — | — |
| `voicemod-api` | not yet | — | — |
| `vrowllabs-vrsync` | not yet | — | — |
| `vystem-api` | not yet | — | — |
| `vyv-photon` | not yet | — | — |
| `wakemedia-stagetime` | not yet | — | — |
| `wallenmedia-cybercaster` | not yet | — | — |
| `warecotech-warecue` | not yet | — | — |
| `waves-lv1` | not yet | — | — |
| `wearefalcon-falconplay` | not yet | — | — |
| `webcomms-panel` | not yet | — | — |
| `wheatstone-wheatnet` | not yet | — | — |
| `wisycom-mat` | not yet | — | — |
| `wled-websocket` | not yet | — | — |
| `wordnik-api` | not yet | — | — |
| `workflownetwork-livetime` | not yet | — | — |
| `wtav-watchout-director-control` | not yet | — | — |
| `wyrestorm-matrix` | not yet | — | — |
| `wyrestorm-sw0402mv` | not yet | — | — |
| `xiamen-sprolink-vd-series` | not yet | — | — |
| `yamaha-ad8hr` | not yet | — | — |
| `yamaha-adecia` | not yet | — | — |
| `yamaha-dm` | not yet | — | — |
| `yamaha-rcp` | implemented | yamaha-rcp | https://download.yamaha.com/files/tcm:39-1251310 |
| `youtube-live` | not yet | — | — |
| `yunxi-yolobox` | not yet | — | — |
| `zanus-pt` | not yet | — | — |
| `zenvideo-ndirouter` | not yet | — | — |
| `zerodensity-realityhub` | not yet | — | — |
| `zigatron-internetclicker` | not yet | — | — |
| `zinc-oscpoint` | not yet | — | — |
| `zipsolutions-zipcaptions` | not yet | — | — |
| `zoneminder-camera` | not yet | — | — |
| `zoom-cavzrc` | not yet | — | — |
| `zoom-osc-iso` | not yet | — | — |
| `zoom-tiles` | not yet | — | — |
| `zowietek-api` | not yet | — | — |
| `zyxel-gs1200` | not yet | — | — |
