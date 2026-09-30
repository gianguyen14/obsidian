# Report 01 — Current OpenWrt Upstream State (BMIPS target)

Date of research: 2026-09-30. All statements below verified by direct inspection
of a freshly cloned OpenWrt tree (no reliance on old brcm63xx tutorials).

## Tree identity

- Repository clone URL used: `https://git.openwrt.org/openwrt/openwrt.git`
- Branch: `main`
- Commit SHA: `edd23eb01e7fff7ebd064ee0e7df90808f5ef282`
  (also HEAD of GitHub mirror `openwrt/openwrt`; commit dated 2026-09-30)
- Local path: `/workspace/sbg3300-openwrt/openwrt`
- Release branches observed via API: `openwrt-24.10`, `openwrt-25.12`
  (current stable line at time of research: 24.10.x / newer 25.12 branch exists;
  we build from `main`).

## Target status — `target/linux/bmips` (VERIFIED_FROM_OPENWRT)

`target/linux/bmips/Makefile`:
- `ARCH := mips`, `CPU_TYPE := mips32`, `BOARD := bmips`
- `SUBTARGETS := bcm6318 bcm6328 bcm6358 bcm6362 bcm6368 bcm63268`
- `FEATURES := gpio squashfs usb`
- **`KERNEL_PATCHVER := 6.18`** (Linux 6.18 series; patch dir
  `target/linux/bmips/patches-6.18`)
- Default packages add `ethtool`, `kmod-gpio-button-hotplug`.

Subtarget `bcm63268` (`target/linux/bmips/bcm63268/target.mk`):
- `FEATURES += nand` → this is the NAND-capable subtarget that BCM63168 boards
  belong to (BCM63168 is a BCM63268-family package variant; all BCM63168 boards
  in-tree use `CHIP_ID := 63268`, `SOC := bcm63168`).

## Kernel config highlights for bcm63268 subtarget
(`target/linux/bmips/bcm63268/config-6.18`, VERIFIED_FROM_OPENWRT)

- CPU/SMP: `CONFIG_BMIPS_GENERIC=y`, `CONFIG_SMP=y`, `CONFIG_NR_CPUS=2`
  → dual-core BMIPS4350 SMP is supported upstream.
- Ethernet: `CONFIG_BCM6368_ENETSW=y` (in-tree BCM63xx enetsw DSA-capable
  driver, added by OpenWrt patch
  `500-net-broadcom-add-BCM6368-enet-controller-driver.patch`);
  `CONFIG_BCM6348_ENET` available (patch 501) but not set for 63268.
- Switch: `CONFIG_B53=y`, `CONFIG_B53_MDIO_DRIVER=y`,
  `CONFIG_B53_MMAP_DRIVER=y`, `CONFIG_B53_SPI_DRIVER=y` → DSA b53 driver
  fully enabled, including MDIO-connected external switches (BCM531x5 family).
  Target patch `110-net-dsa-b53-bcm531x5-fix-cpu-rgmii-mode-interpretation.patch`
  fixes BCM531x5 CPU-port RGMII delay interpretation.
- NAND: `CONFIG_MTD_NAND_BRCMNAND=y`, `CONFIG_MTD_NAND_BRCMNAND_BCM63XX=y`,
  `CONFIG_MTD_RAW_NAND=y`, `CONFIG_MTD_UBI=y`, `CONFIG_UBIFS_FS=y`,
  `CONFIG_MTD_SPLIT_BCM_WFI_FW=y`.
- Watchdog: `CONFIG_BCM7038_WDT=y` (used by bcm63268.dtsi `wdt` node).
- Reboot: `syscon-reboot` node at `pll_cntl` (0x10000008) in `bcm63268.dtsi`.
- USB: per-device kmods (`USB2_PACKAGES := kmod-usb2 kmod-usb-ohci
  kmod-usb-ledtrig-usbport`) enabled through device profiles; DT nodes
  `ehci` (brcm,bcm63268-ehci), `ohci`, `usbh` phy exist in `bcm63268.dtsi`.
- LEDs: `kmod-leds-bcm6328` (LED controller at 0x10001900) and
  `kmod-gpio-button-hotplug`.

## Memory map constants (target/linux/bmips/image/Makefile, VERIFIED_FROM_OPENWRT)

- RAM base assumed `0x80000000`.
- `KERNEL_LOADADDR := 0x80010000`  (RAM start + 64 KiB)
- `LOADER_ENTRY     := 0x81000000` (RAM start + 16 MiB, relocate-kernel loader)
- `LZMA_TEXT_START  := 0x82000000` (RAM start + 32 MiB)
- `UBOOT_ENTRY      := 0x81c00000`

RAM size and CPU frequency are NOT hardcoded in DTS: OpenWrt patches
`200-mips-bmips-automatically-detect-CPU-frequency.patch` and
`201-mips-bmips-automatically-detect-RAM-size.patch` probe them at boot.
For BCM63268/63168 the RAM size is derived from the memory controller at
`0x10003000` (`SDRAM_CFG_REG` space field, `MEMC_CFG_REG` row/col/bus-width),
so an unknown-but-correct DDR2 sizing (expected 128 MiB) is auto-detected.
This is important: our DTS may keep `memory@0 { reg = <0 0>; }` like every
other bcm63168 board DTS in-tree.

## Boot methods implemented in bmips image build system

- `Device/bcm63xx-cfe` (NOR flash CFE devices):
  `KERNEL_INITRAMFS := kernel-bin | append-dtb | lzma | loader-lzma elf`
  producing `openwrt-*-initramfs.elf` — an ELF-wrapped LZMA self-decompressor
  (from `image/lzma-loader`) with UART support; `UART_BASE_63268 := 0xb0000180`.
- `Device/bcm63xx-nand` (NAND CFE devices — what SBG3300 needs):
  same `KERNEL_INITRAMFS` recipe → `.elf` initramfs artifact identical format.
- Flash images use `imagetag` host tool with `--boardid $(CFE_BOARD_ID)` and
  `--chipid $(CHIP_ID)` (Broadcom CFE imagetag header), or Sercomm/Comtrend
  WFI-tag variants.

## Existing BCM63168-class reference devices in-tree (subtarget bcm63268)

From `target/linux/bmips/image/bcm63268.mk` and `target/linux/bmips/dts/`:

| Device | SOC | Image class | NAND? | DTS |
|---|---|---|---|---|
| Actiontec T1200H | bcm63168 | bcm63xx-nand | yes | bcm63168-actiontec-t1200h.dts |
| Comtrend VR-3032u | bcm63168 | bcm63xx-nand | yes | bcm63168-comtrend-vr-3032u.dts |
| Sagem F@ST 3864 OP | bcm63168 | bcm63xx-nand | yes | bcm63168-sagem-fast-3864-op.dts |
| Sercomm SHG2500 | bcm63168 | sercomm-nand | yes | bcm63168-sercomm-shg2500.dts |
| SmartRG SR505n | bcm63168 | bcm63xx-cfe | no (SPI NOR) | bcm63168-smartrg-sr505n.dts |
| Comtrend VG-8050 | bcm63169 | bcm63xx-nand | yes | bcm63169-comtrend-vg-8050.dts |
| Sercomm H500-s ×2 | bcm63167 | sercomm-nand | yes | bcm63167-sercomm-h500-s*.dts |

All share `target/linux/bmips/dts/bcm63268.dtsi` (SoC include: CPUs
`brcm,bmips4350` ×2, peripherals, internal robosw switch0 + mdio mux
(`mdio_int`/`mdio_ext`), nflash, ehci/ohci/usbh, uart0/uart1, wdt, leds).

## Conclusions for the port

- Correct architecture today: **target `bmips`, subtarget `bcm63268`,
  kernel 6.18, big-endian MIPS32 BMIPS4350 SMP**. The obsolete `brcm63xx`
  swconfig-era target knowledge does NOT apply; bmips uses DSA (b53 +
  bcm6368-enetsw as DSA master tagged "brcm,bcm63268-switch").
- A BCM63168 NAND board port should be modeled on the four in-tree BCM63168
  NAND devices; the Sercomm SHG2500 is the closest architecturally because it
  uses an **external BCM53125 switch on the external MDIO bus** (exactly the
  reported SBG3300 topology).
- Initramfs artifact type: `openwrt-bmips-bcm63268-<device>-initramfs.elf`
  (LZMA + loader-lzma ELF), suitable for CFE `boot -raw -z` style RAM loading
  or ELF loading depending on CFE generation.
