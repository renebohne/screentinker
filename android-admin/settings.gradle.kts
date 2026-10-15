pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

// ScreenTinker Manager: the phone app for keeping screens up to date. The player app is android/.
rootProject.name = "ScreenTinkerManager"
include(":app")
