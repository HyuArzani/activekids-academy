const unsplash = (photoId: string, width = 1400) =>
  `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=${width}&q=85`;

export const publicSiteConfig = {
  academyName: "Futsal Academy",
  logo: {
    text: "FUTSAL",
    subtext: "ACADEMY",
    image: "",
    imageAlt: "Futsal Academy",
  },
  contact: {
    email: "",
    phone: "",
    whatsapp: "",
  },
  socialLinks: {
    instagram: "",
    youtube: "",
    tiktok: "",
  },
  landing: {
    hero: {
      eyebrow: "Akademi futsal untuk generasi hebat",
      title: "PLAY. LEARN.",
      accentTitle: "GROW.",
      description:
        "Lebih dari sekadar futsal. Tempat anak belajar, berkembang, membangun karakter, dan meraih potensi terbaiknya.",
      image: unsplash("photo-1521412644187-c49fa049e84d"),
      imageAlt: "Pemain berlatih dan bermain sepak bola di lapangan",
      videoId: "",
    },
    highlights: [
      { icon: "trophy", title: "Pelatih Berpengalaman" },
      { icon: "chart", title: "Program Latihan Terstruktur" },
      { icon: "shield", title: "Pengembangan Karakter" },
      { icon: "users", title: "Lingkungan Latihan Positif" },
    ],
    programs: [
      {
        name: "SEMANGAT",
        description:
          "Program pembinaan untuk membangun dasar kemampuan futsal, kepercayaan diri, dan semangat belajar.",
        ageGroup: "Informasi kelompok usia menyusul",
        image: unsplash("photo-1517466787929-bc90951d0974", 900),
        imageAlt: "Latihan dasar futsal bersama tim",
      },
      {
        name: "MEMBARA",
        description:
          "Program pengembangan kemampuan teknik, permainan, kerja sama, dan pemahaman permainan.",
        ageGroup: "Informasi kelompok usia menyusul",
        image: unsplash("photo-1508098682722-e99c43a406b2", 900),
        imageAlt: "Pemain futsal berlatih teknik bersama",
      },
      {
        name: "ADVANCE",
        description:
          "Program pengembangan lanjutan untuk meningkatkan kualitas teknik, taktik, dan kesiapan bertanding.",
        ageGroup: "Informasi kelompok usia menyusul",
        image: unsplash("photo-1574629810360-7efbbe195018", 900),
        imageAlt: "Lapangan olahraga untuk latihan lanjutan",
      },
    ],
    about: {
      image: unsplash("photo-1526232761682-d26e03ac148e"),
      imageAlt: "Pelatih mendampingi pemain muda saat latihan",
      title: "BUILDING BETTER PLAYERS, TOGETHER",
      description:
        "Kami menghadirkan pengalaman belajar futsal yang terarah dan menyenangkan. Dengan pendampingan yang positif, setiap anak mendapat ruang untuk mencoba, bertumbuh, dan menemukan potensinya.",
      mission:
        "Mendampingi setiap pemain berkembang melalui latihan berkualitas, kerja sama, dan rasa hormat.",
      values: [
        "Latihan yang aman dan suportif",
        "Pengembangan karakter",
        "Kerja sama dan disiplin",
        "Semangat belajar sepanjang perjalanan",
      ],
    },
    trainingPhotos: [
      {
        image: unsplash("photo-1517466787929-bc90951d0974", 900),
        alt: "Pemain melakukan latihan teknik di lapangan",
      },
      {
        image: unsplash("photo-1521412644187-c49fa049e84d", 900),
        alt: "Suasana latihan sepak bola bersama",
      },
      {
        image: unsplash("photo-1508098682722-e99c43a406b2", 900),
        alt: "Latihan permainan tim di lapangan",
      },
    ],
    featuredVideo: {
      id: "",
      title: "Aksi dan Kegiatan Latihan",
      description:
        "Lihat lebih dekat semangat belajar dan suasana latihan di lapangan.",
      thumbnail: unsplash("photo-1574629810360-7efbbe195018"),
      thumbnailAlt: "Lapangan futsal sebagai pratinjau video latihan",
    },
  },
  coaches: {
    heroImage: unsplash("photo-1526232761682-d26e03ac148e"),
    heroImageAlt: "Pelatih mendampingi pemain muda saat latihan futsal",
    profiles: [
      {
        name: "Coach 01",
        position: "Posisi pelatih akan diperbarui",
        biography:
          "Profil pelatih akan diperbarui setelah informasi dan foto resmi tersedia.",
        experience: "Informasi pengalaman segera hadir",
        portrait: unsplash("photo-1500648767791-00dcc994a43e", 700),
      },
      {
        name: "Coach 02",
        position: "Posisi pelatih akan diperbarui",
        biography:
          "Profil pelatih akan diperbarui setelah informasi dan foto resmi tersedia.",
        experience: "Informasi pengalaman segera hadir",
        portrait: unsplash("photo-1506794778202-cad84cf45f1d", 700),
      },
      {
        name: "Coach 03",
        position: "Posisi pelatih akan diperbarui",
        biography:
          "Profil pelatih akan diperbarui setelah informasi dan foto resmi tersedia.",
        experience: "Informasi pengalaman segera hadir",
        portrait: unsplash("photo-1507003211169-0a1dd7228f2d", 700),
      },
    ],
    philosophy: [
      {
        icon: "activity",
        title: "Learn Through Practice",
        description:
          "Kemampuan tumbuh dari latihan yang konsisten, menyenangkan, dan sesuai tahap perkembangan.",
      },
      {
        icon: "shield",
        title: "Discipline and Respect",
        description:
          "Membangun kebiasaan disiplin, saling menghargai, dan bertanggung jawab.",
      },
      {
        icon: "users",
        title: "Teamwork and Sportsmanship",
        description:
          "Belajar bekerja sama, mendukung teman, dan bermain dengan sikap sportif.",
      },
      {
        icon: "sparkles",
        title: "Confidence and Development",
        description:
          "Memberi setiap pemain ruang untuk mencoba, percaya diri, dan berkembang.",
      },
    ],
    trainingPhotos: [
      {
        image: unsplash("photo-1521412644187-c49fa049e84d", 900),
        alt: "Pelatih memandu pemain saat latihan teknik",
        caption: "Latihan teknik",
      },
      {
        image: unsplash("photo-1517466787929-bc90951d0974", 900),
        alt: "Pemain berlatih bersama di lapangan",
        caption: "Latihan bersama",
      },
      {
        image: unsplash("photo-1526232761682-d26e03ac148e", 900),
        alt: "Pendampingan pelatih di lapangan",
        caption: "Pendampingan pelatih",
      },
      {
        image: unsplash("photo-1508098682722-e99c43a406b2", 900),
        alt: "Tim melakukan latihan permainan",
        caption: "Permainan tim",
      },
    ],
    trainingVideos: [
      {
        title: "Training Session 01",
        description: "Cuplikan sesi latihan akademi.",
        videoId: "",
        thumbnail: unsplash("photo-1574629810360-7efbbe195018", 900),
      },
      {
        title: "Technical Training",
        description: "Latihan teknik dan penguasaan bola.",
        videoId: "",
        thumbnail: unsplash("photo-1517466787929-bc90951d0974", 900),
      },
      {
        title: "Team Practice",
        description: "Membangun komunikasi dan kerja sama tim.",
        videoId: "",
        thumbnail: unsplash("photo-1521412644187-c49fa049e84d", 900),
      },
      {
        title: "Match Preparation",
        description: "Persiapan permainan bersama tim pelatih.",
        videoId: "",
        thumbnail: unsplash("photo-1508098682722-e99c43a406b2", 900),
      },
    ],
  },
} as const;

export type PublicSiteConfig = typeof publicSiteConfig;
