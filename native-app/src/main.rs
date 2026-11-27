//! RiftWatch native app — phase 2: tabbed UI backed by the existing Rust API
//! and a local JSON store. No webview, no browser runtime.

mod api;
mod models;
mod store;

use futures::SinkExt;
use iced::widget::{button, column, container, row, scrollable, text, text_input};
use iced::{Background, Color, Element, Length, Subscription, Task};
use models::{HistoryEntry, MediaItem, Settings, WatchEntry};
use store::Store;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Detail,
    Home,
    Search,
    Watchlist,
    History,
    Settings,
}

#[derive(Debug, Clone)]
enum Message {
    BackendPort(u16),
    BackendError(String),
    Tab(Tab),
    SearchInput(String),
    Search,
    SearchLoaded(Vec<MediaItem>),
    HomeLoaded {
        trending: Vec<MediaItem>,
        popular: Vec<MediaItem>,
    },
    OpenDetail(MediaItem),
    DetailLoaded {
        item: MediaItem,
        episodes: Vec<u32>,
        sub: u32,
        dub: u32,
    },
    PlayEpisode {
        item: MediaItem,
        episode: u32,
    },
    AddWatchlist(MediaItem),
    RemoveWatchlist(String),
    ToggleAutoplay(bool),
    ToggleAutoSkip(bool),
    Error(String),
}

struct App {
    port: Option<u16>,
    tab: Tab,
    query: String,
    trending: Vec<MediaItem>,
    popular: Vec<MediaItem>,
    results: Vec<MediaItem>,
    detail: Option<MediaItem>,
    detail_episodes: Vec<u32>,
    detail_counts: (u32, u32),
    store: Store,
    error: Option<String>,
    loading: bool,
}

impl Default for App {
    fn default() -> Self {
        Self {
            port: None,
            tab: Tab::Home,
            query: String::new(),
            trending: Vec::new(),
            popular: Vec::new(),
            results: Vec::new(),
            detail: None,
            detail_episodes: Vec::new(),
            detail_counts: (0, 0),
            store: Store::load(),
            error: None,
            loading: false,
        }
    }
}

fn backend_path() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let release = exe.parent().unwrap_or(std::path::Path::new("."));
    let candidates = [
        release.join("riftwatch-backend.exe"),
        release.join("..").join("..").join("..").join("rust-backend").join("target").join("release").join("riftwatch-backend.exe"),
    ];
    candidates.iter().find(|p| p.exists()).cloned().unwrap_or_else(|| candidates[0].clone())
}

fn backend_subscription() -> Subscription<Message> {
    iced::Subscription::run(|| {
        iced::stream::channel(32, |mut output: futures::channel::mpsc::Sender<Message>| async move {
            let path = backend_path();
            let mut command = Command::new(&path);
            command
                .env("PORT", "0")
                .env("RIFTWATCH_BIND", "127.0.0.1")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    let _ = output
                        .send(Message::BackendError(format!(
                            "Could not start {}: {error}",
                            path.display()
                        )))
                        .await;
                    return;
                }
            };

            if let Some(stdout) = child.stdout.take() {
                let mut lines = tokio::io::BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(port) = line.trim().strip_prefix("RIFTWATCH_PORT=") {
                        if let Ok(port) = port.parse::<u16>() {
                            let _ = output.send(Message::BackendPort(port)).await;
                        }
                    }
                }
            }
            let _ = child.wait().await;
        })
    })
}

fn items(values: Vec<serde_json::Value>) -> Vec<MediaItem> {
    values.iter().map(MediaItem::from_json).filter(|i| !i.title().is_empty()).take(40).collect()
}

fn load_home(port: u16) -> Task<Message> {
    Task::batch(vec![
        Task::perform(api::trending(port), |result| match result {
            Ok(values) => Message::HomeLoaded {
                trending: items(values),
                popular: Vec::new(),
            },
            Err(error) => Message::Error(error),
        }),
        Task::perform(api::popular(port), |result| match result {
            Ok(values) => Message::HomeLoaded {
                trending: Vec::new(),
                popular: items(values),
            },
            Err(error) => Message::Error(error),
        }),
    ])
}

fn load_detail(port: u16, item: MediaItem) -> Task<Message> {
    let fetch_item = item.clone();
    Task::perform(
        async move { api::episodes(port, &fetch_item.id).await },
        move |result| match result {
            Ok(value) => {
                let count = |mode: &str| -> u32 {
                    value
                        .get("availableEpisodesDetail")
                        .and_then(|d| d.get(mode))
                        .and_then(|v| v.as_array())
                        .map(|a| a.len() as u32)
                        .unwrap_or(0)
                };
                let sub = count("sub");
                let dub = count("dub");
                Message::DetailLoaded {
                    item: item.clone(),
                    episodes: (1..=sub.max(dub).min(500)).collect(),
                    sub,
                    dub,
                }
            }
            Err(error) => Message::Error(error),
        },
    )
}

impl App {
    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::BackendPort(port) => {
                self.port = Some(port);
                self.error = None;
                load_home(port)
            }
            Message::BackendError(error) => {
                self.error = Some(error);
                Task::none()
            }
            Message::Tab(tab) => {
                self.tab = tab;
                self.error = None;
                if tab == Tab::Home {
                    if let Some(port) = self.port {
                        return load_home(port);
                    }
                }
                Task::none()
            }
            Message::SearchInput(query) => {
                self.query = query;
                Task::none()
            }
            Message::Search => match self.port {
                Some(port) if !self.query.trim().is_empty() => {
                    self.loading = true;
                    self.error = None;
                    let query = self.query.clone();
                    Task::perform(
                        async move { api::search(port, &query).await },
                        |result| match result {
                            Ok(values) => Message::SearchLoaded(items(values)),
                            Err(error) => Message::Error(error),
                        },
                    )
                }
                _ => {
                    self.error = Some("Enter a search term".to_string());
                    Task::none()
                }
            },
            Message::SearchLoaded(results) => {
                self.loading = false;
                self.results = results;
                Task::none()
            }
            Message::HomeLoaded { trending, popular } => {
                if !trending.is_empty() {
                    self.trending = trending;
                }
                if !popular.is_empty() {
                    self.popular = popular;
                }
                Task::none()
            }
            Message::OpenDetail(item) => {
                self.detail = Some(item.clone());
                self.tab = Tab::Detail;
                self.detail_episodes.clear();
                self.error = None;
                match self.port {
                    Some(port) => load_detail(port, item),
                    None => {
                        self.error = Some("Backend is still starting".to_string());
                        Task::none()
                    }
                }
            }
            Message::DetailLoaded {
                item,
                episodes,
                sub,
                dub,
            } => {
                if self.detail.as_ref().is_some_and(|d| d.id == item.id) {
                    self.detail_episodes = episodes;
                    self.detail_counts = (sub, dub);
                }
                Task::none()
            }
            Message::PlayEpisode { item, episode } => {
                self.store.history.insert(
                    0,
                    HistoryEntry {
                        item,
                        episode,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    },
                );
                self.store.history.truncate(500);
                self.store.save();
                self.error = Some("Video playback is not wired up in the native build yet".to_string());
                Task::none()
            }
            Message::AddWatchlist(item) => {
                if !self.store.watchlist.iter().any(|w| w.item.id == item.id) {
                    self.store.watchlist.push(WatchEntry {
                        item,
                        status: "watching".to_string(),
                    });
                    self.store.save();
                }
                Task::none()
            }
            Message::RemoveWatchlist(id) => {
                self.store.watchlist.retain(|w| w.item.id != id);
                self.store.save();
                Task::none()
            }
            Message::ToggleAutoplay(value) => {
                self.store.settings.autoplay = value;
                self.store.save();
                Task::none()
            }
            Message::ToggleAutoSkip(value) => {
                self.store.settings.auto_skip = value;
                self.store.save();
                Task::none()
            }
            Message::Error(error) => {
                self.loading = false;
                self.error = Some(error);
                Task::none()
            }
        }
    }

    fn tabs(&self) -> Element<'_, Message> {
        row![
            button(text("Home")).on_press(Message::Tab(Tab::Home)).padding([6, 12]),
            button(text("Search")).on_press(Message::Tab(Tab::Search)).padding([6, 12]),
            button(text("Watchlist")).on_press(Message::Tab(Tab::Watchlist)).padding([6, 12]),
            button(text("History")).on_press(Message::Tab(Tab::History)).padding([6, 12]),
            button(text("Settings")).on_press(Message::Tab(Tab::Settings)).padding([6, 12]),
        ]
        .spacing(8)
        .into()
    }

    fn item_rows<'a>(&'a self, list: &'a [MediaItem], show_add: bool) -> Element<'a, Message> {
        let mut content = column![].spacing(8);
        if list.is_empty() {
            content = content.push(text("Nothing here yet."));
        }
        for item in list {
            let mut controls = row![button(text(item.title()).size(16))
                .on_press(Message::OpenDetail(item.clone()))
                .padding(0)];
            if !item.score.is_empty() {
                controls = controls.push(text(format!("★ {}", item.score)));
            }
            if show_add && !item.id.is_empty() {
                controls = controls.push(button("+ Watchlist").on_press(Message::AddWatchlist(item.clone())));
            }
            content = content.push(controls.spacing(12));
        }
        scrollable(content).height(Length::Fill).into()
    }

    fn view(&self) -> Element<'_, Message> {
        let mut body = column![text("RiftWatch").size(28), self.tabs()].spacing(14);

        match self.tab {
            Tab::Detail => {
                if let Some(item) = &self.detail {
                    body = body.push(text(item.title()).size(24));
                    body = body.push(text(format!(
                        "Sub: {} · Dub: {}",
                        self.detail_counts.0, self.detail_counts.1
                    )));
                    body = body.push(button("+ Watchlist").on_press(Message::AddWatchlist(item.clone())));
                    let mut episodes = column![].spacing(4);
                    if self.detail_episodes.is_empty() {
                        episodes = episodes.push(text("Loading episodes…"));
                    }
                    for ep in &self.detail_episodes {
                        episodes = episodes.push(
                            button(text(format!("Episode {ep}")))
                                .on_press(Message::PlayEpisode {
                                    item: item.clone(),
                                    episode: *ep,
                                })
                                .padding(4),
                        );
                    }
                    body = body.push(scrollable(episodes).height(Length::Fill));
                }
            }
            Tab::Home => {
                body = body.push(text("Trending").size(20));
                body = body.push(self.item_rows(&self.trending, true));
                body = body.push(text("Popular").size(20));
                body = body.push(self.item_rows(&self.popular, true));
            }
            Tab::Search => {
                body = body.push(
                    text_input("Search anime…", &self.query)
                        .on_input(Message::SearchInput)
                        .on_submit(Message::Search)
                        .width(Length::Fill),
                );
                body = body.push(button("Search").on_press(Message::Search));
                body = body.push(self.item_rows(&self.results, true));
            }
            Tab::Watchlist => {
                let entries: Vec<MediaItem> = self.store.watchlist.iter().map(|w| w.item.clone()).collect();
                let mut list = column![].spacing(8);
                if entries.is_empty() {
                    list = list.push(text("Your watchlist is empty."));
                }
                for entry in &self.store.watchlist {
                    list = list.push(
                        row![
                            text(entry.item.title()),
                            button("Remove").on_press(Message::RemoveWatchlist(entry.item.id.clone())),
                        ]
                        .spacing(12),
                    );
                }
                body = body.push(scrollable(list).height(Length::Fill));
            }
            Tab::History => {
                let entries: Vec<&HistoryEntry> = self.store.history.iter().collect();
                let mut list = column![].spacing(8);
                if entries.is_empty() {
                    list = list.push(text("Nothing watched yet."));
                }
                for entry in entries {
                    list = list.push(text(format!(
                        "{} — episode {}",
                        entry.item.title(),
                        entry.episode
                    )));
                }
                let _ = entries;
                body = body.push(scrollable(list).height(Length::Fill));
            }
            Tab::Settings => {
                let settings: &Settings = &self.store.settings;
                body = body.push(
                    column![
                        "Autoplay next episode",
                        button(if settings.autoplay { "On" } else { "Off" })
                            .on_press(Message::ToggleAutoplay(!settings.autoplay)),
                    ]
                    .spacing(6),
                );
                body = body.push(
                    column![
                        "Auto-skip openings & endings",
                        button(if settings.auto_skip { "On" } else { "Off" })
                            .on_press(Message::ToggleAutoSkip(!settings.auto_skip)),
                    ]
                    .spacing(6),
                );
                body = body.push(text(format!(
                    "Backend: {}",
                    self.port
                        .map(|p| format!("127.0.0.1:{p}"))
                        .unwrap_or_else(|| "starting…".to_string())
                )));
            }
        }

        if let Some(error) = &self.error {
            body = body.push(text(error));
        }
        if self.loading {
            body = body.push(text("Loading…"));
        }

        container(column![body].padding(24).width(Length::Fill).height(Length::Fill))
            .width(Length::Fill)
            .height(Length::Fill)
            .style(|_| container::Style {
                background: Some(Background::Color(Color::from_rgb(0.07, 0.07, 0.10))),
                text_color: Some(Color::WHITE),
                ..Default::default()
            })
            .into()
    }

    fn subscription(&self) -> Subscription<Message> {
        backend_subscription()
    }
}

fn main() -> iced::Result {
    iced::application(App::default, App::update, App::view)
        .title("RiftWatch")
        .subscription(App::subscription)
        .window_size((1000.0, 720.0))
        .run()
}
